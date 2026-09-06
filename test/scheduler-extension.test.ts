import { afterAll, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The extension only uses these packages for registration/rendering. Mock them so this
// test exercises the extension lifecycle without requiring a full Pi installation.
mock.module("@earendil-works/pi-ai", () => ({
	StringEnum: (values: string[], options: Record<string, unknown> = {}) => ({ values, ...options }),
}));
mock.module("@earendil-works/pi-tui", () => ({
	Text: class Text {
		constructor(..._args: unknown[]) {}
	},
}));
mock.module("typebox", () => ({
	Type: {
		Object: (value: unknown) => value,
		Optional: (value: unknown) => value,
		String: (value: unknown = {}) => value,
		Number: (value: unknown = {}) => value,
		Boolean: (value: unknown = {}) => value,
	},
}));

type Context = {
	hasUI: boolean;
	cwd: string;
	ui: { notify: () => void; setStatus: () => void; setWidget: () => void };
	sessionManager: { getSessionFile: () => string };
	isIdle: () => boolean;
};

type Harness = {
	home: string;
	activeCtx: Context;
	handlerCtx: Context;
	tools: Map<string, any>;
	commands: Map<string, any>;
	timers: Set<ReturnType<typeof setTimeout>>;
	clearedTimers: Set<ReturnType<typeof setTimeout>>;
	cleanup: () => Promise<void>;
};

const extensionUrl = new URL("../extensions/scheduler/index.ts", import.meta.url);
const STATE_FILE = join(process.env.HOME ?? "", ".pi", "agent", "state", "scheduler", "tasks.json");
const BACKUP_STATE_FILE = `${STATE_FILE}.context-regression-backup-${process.pid}`;
const testHome = await mkdtemp(join(tmpdir(), "pi-scheduler-extension-test-"));

let savedState: string | undefined;
try {
	savedState = await Bun.file(STATE_FILE).text();
} catch {
	// No preexisting user scheduler state.
}

/**
 * node:os homedir is immutable after process start, so write directly to the extension's
 * real state path and restore it after this serial test file instead of changing HOME.
 */
afterAll(async () => {
	if (savedState === undefined) await rm(STATE_FILE, { force: true });
	else await writeFile(STATE_FILE, savedState, "utf8");
	await rm(BACKUP_STATE_FILE, { force: true });
	await rm(testHome, { recursive: true, force: true });
});

function pendingTask(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
	return {
		id,
		name: id,
		action: "notify",
		type: "once",
		schedule: "1h",
		message: id,
		createdAt: new Date().toISOString(),
		dueAt,
		nextRun: dueAt,
		status: "pending",
		enabled: true,
		runCount: 0,
		scope: "session",
		sessionFile: "/sessions/active.jsonl",
		...overrides,
	};
}

async function writeTasks(tasks: Record<string, unknown>[]): Promise<void> {
	await mkdir(dirname(STATE_FILE), { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify({ version: 2, tasks }), "utf8");
}

async function startHarness(tasks: Record<string, unknown>[], testId: number): Promise<Harness> {
	await writeTasks(tasks);

	const events = new Map<string, any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const messages: unknown[] = [];
	const pi = {
		on: (name: string, handler: unknown) => events.set(name, handler),
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerMessageRenderer: () => {},
		sendMessage: (message: unknown) => messages.push(message),
		sendUserMessage: () => {},
		exec: async () => ({ code: 0, killed: false, stdout: "", stderr: "" }),
	};

	const schedulerExtension = (await import(`${extensionUrl.href}?context-regression=${testId}`)).default;
	schedulerExtension(pi as any);

	const makeContext = (): Context => ({
		hasUI: false,
		cwd: "/work/project",
		ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
		sessionManager: { getSessionFile: () => "/sessions/active.jsonl" },
		isIdle: () => true,
	});
	const activeCtx = makeContext();
	const handlerCtx = makeContext();
	expect(handlerCtx).not.toBe(activeCtx); // Pi creates a context per dispatch.

	const timers = new Set<ReturnType<typeof setTimeout>>();
	const clearedTimers = new Set<ReturnType<typeof setTimeout>>();
	const nativeSetTimeout = globalThis.setTimeout;
	const nativeClearTimeout = globalThis.clearTimeout;
	globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
		const timer = nativeSetTimeout(callback, delay, ...args);
		timers.add(timer);
		return timer;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
		clearedTimers.add(timer);
		return nativeClearTimeout(timer);
	}) as typeof clearTimeout;

	await events.get("session_start")({ type: "session_start" }, activeCtx);

	return {
		home: testHome,
		activeCtx,
		handlerCtx,
		tools,
		commands,
		timers,
		clearedTimers,
		cleanup: async () => {
			for (const timer of timers) nativeClearTimeout(timer);
			globalThis.setTimeout = nativeSetTimeout;
			globalThis.clearTimeout = nativeClearTimeout;
			void messages;
		},
	};
}

async function withHarness(
	tasks: Record<string, unknown>[],
	testId: number,
	run: (harness: Harness) => Promise<void>,
): Promise<void> {
	const harness = await startHarness(tasks, testId);
	try {
		await run(harness);
	} finally {
		await harness.cleanup();
	}
}

/**
 * Pi invokes session_start and each command/tool handler with distinct ExtensionContext
 * objects. Every mutation that changes the pending schedule must therefore re-arm using
 * the stored session context, rather than silently returning at isSessionActive().
 */
test.serial("tool task creation re-arms the active session when its context differs", async () => {
	await withHarness([pendingTask("existing")], 1, async ({ tools, handlerCtx, timers, clearedTimers }) => {
		const before = new Set(timers);
		await tools.get("schedule_task").execute("call", {
			action: "notify",
			type: "once",
			schedule: "1h",
			message: "new task",
		}, undefined, undefined, handlerCtx);

		expect([...before].every((timer) => clearedTimers.has(timer))).toBe(true);
		expect([...timers].filter((timer) => !before.has(timer)).length).toBe(2);
	});
});

test.serial("schedule and remind commands re-arm after creating tasks from distinct contexts", async () => {
	for (const [index, command] of ["schedule", "remind"].entries()) {
		await withHarness([pendingTask("existing")], 10 + index, async ({ commands, handlerCtx, timers, clearedTimers }) => {
			const before = new Set(timers);
			const args = command === "schedule" ? "notify once 1h :: command task" : "1h command task";
			await commands.get(command).handler(args, handlerCtx);

			expect([...before].every((timer) => clearedTimers.has(timer))).toBe(true);
			expect([...timers].filter((timer) => !before.has(timer)).length).toBe(2);
		});
	}
});

test.serial("enable mutations install a handle when called from tool and command contexts", async () => {
	const disabled = pendingTask("disabled", { enabled: false, status: "cancelled" });
	for (const [index, invocation] of ["tool", "command"].entries()) {
		await withHarness([disabled], 20 + index, async ({ tools, commands, handlerCtx, timers, clearedTimers }) => {
			expect([...timers].filter((timer) => !clearedTimers.has(timer)).length).toBe(0);
			if (invocation === "tool") {
				await tools.get("manage_scheduled_task").execute(
					"call",
					{ action: "enable", id: "disabled" },
					undefined,
					undefined,
					handlerCtx,
				);
			} else {
				await commands.get("schedule-enable").handler("disabled", handlerCtx);
			}
			expect([...timers].filter((timer) => !clearedTimers.has(timer)).length).toBe(1);
		});
	}
});

test.serial("tool update replaces the active timeout from a distinct context", async () => {
	await withHarness([pendingTask("editable")], 30, async ({ tools, handlerCtx, timers, clearedTimers }) => {
		const before = new Set(timers);
		await tools.get("manage_scheduled_task").execute(
			"call",
			{ action: "update", id: "editable", schedule: "2h" },
			undefined,
			undefined,
			handlerCtx,
		);
		expect([...before].every((timer) => clearedTimers.has(timer))).toBe(true);
		expect([...timers].some((timer) => !before.has(timer))).toBe(true);
	});
});

test.serial("disable and cancel mutations clear stale handles for every handler surface", async () => {
	const cases: Array<{ name: string; invoke: (h: Harness) => Promise<void> }> = [
		{
			name: "manage disable",
			invoke: (h) => h.tools.get("manage_scheduled_task").execute("call", { action: "disable", id: "task" }, undefined, undefined, h.handlerCtx),
		},
		{
			name: "cancel tool",
			invoke: (h) => h.tools.get("cancel_scheduled_task").execute("call", { id: "task" }, undefined, undefined, h.handlerCtx),
		},
		{ name: "schedule-disable", invoke: (h) => h.commands.get("schedule-disable").handler("task", h.handlerCtx) },
		{ name: "schedule-cancel", invoke: (h) => h.commands.get("schedule-cancel").handler("task", h.handlerCtx) },
	];
	for (const [index, scenario] of cases.entries()) {
		await withHarness([pendingTask("task")], 40 + index, async (harness) => {
			const before = new Set(harness.timers);
			await scenario.invoke(harness);
			expect([...before].every((timer) => harness.clearedTimers.has(timer)), scenario.name).toBe(true);
		});
	}
});

test.serial("remove and cleanup re-arm remaining tasks for tool and command contexts", async () => {
	const cases: Array<{ name: string; invoke: (h: Harness) => Promise<void> }> = [
		{
			name: "manage remove",
			invoke: (h) => h.tools.get("manage_scheduled_task").execute("call", { action: "remove", id: "remove" }, undefined, undefined, h.handlerCtx),
		},
		{
			name: "manage cleanup",
			invoke: (h) => h.tools.get("manage_scheduled_task").execute("call", { action: "cleanup" }, undefined, undefined, h.handlerCtx),
		},
		{ name: "schedule-remove", invoke: (h) => h.commands.get("schedule-remove").handler("remove", h.handlerCtx) },
		{ name: "schedule-cleanup", invoke: (h) => h.commands.get("schedule-cleanup").handler("", h.handlerCtx) },
	];
	for (const [index, scenario] of cases.entries()) {
		const removable = pendingTask("remove", { enabled: false, status: "cancelled" });
		await withHarness([pendingTask("survivor"), removable], 50 + index, async (harness) => {
			const before = new Set(harness.timers);
			await scenario.invoke(harness);
			expect([...before].every((timer) => harness.clearedTimers.has(timer)), scenario.name).toBe(true);
			expect([...harness.timers].some((timer) => !before.has(timer)), scenario.name).toBe(true);
		});
	}
});

test.serial("read-only list and widget handlers accept a distinct dispatch context", async () => {
	await withHarness([pendingTask("task")], 60, async ({ tools, commands, handlerCtx }) => {
		await tools.get("list_scheduled_tasks").execute("call", {}, undefined, undefined, handlerCtx);
		await commands.get("schedules").handler("", handlerCtx);
		await commands.get("schedule-widget").handler("off", handlerCtx);
	});
});
