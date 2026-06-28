import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand";
import { makeQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { removeRecentTask } from "@/lib/recent-tasks";
import type { AppState } from "@/lib/state/store";
import { registerTasksHandlers } from "./tasks";

vi.mock("@/lib/recent-tasks", () => ({
  removeRecentTask: vi.fn(),
}));

const SESS_OTHER = "sess-other";
const SESS_DRIFTED = "sess-drifted";
const SESS_PINNED = "sess-pinned";

type Listener = (state: AppState) => void;

/**
 * Minimal in-memory store for the tasks WS handler tests.
 * The handler reads task/session UI state and performs client-local cleanup side effects;
 * everything else can stay default.
 */
function makeStore(initial: Partial<AppState> = {}) {
  let state = {
    tasks: {
      activeTaskId: null,
      activeSessionId: null,
      pinnedSessionId: null,
      lastSessionByTaskId: {},
    },
    taskSessionsByTask: { itemsByTaskId: {}, loadedByTaskId: {}, loadingByTaskId: {} },
    environmentIdBySessionId: {},
    setActiveSession: vi.fn((taskId: string, sessionId: string | null) => {
      state = {
        ...state,
        tasks: {
          activeTaskId: taskId,
          activeSessionId: sessionId,
          pinnedSessionId: sessionId,
          lastSessionByTaskId: sessionId
            ? { ...state.tasks.lastSessionByTaskId, [taskId]: sessionId }
            : state.tasks.lastSessionByTaskId,
        },
      };
    }),
    setActiveSessionAuto: vi.fn((taskId: string, sessionId: string | null) => {
      state = {
        ...state,
        tasks: {
          ...state.tasks,
          activeTaskId: taskId,
          activeSessionId: sessionId,
        },
      };
    }),
    removeTaskFromSidebarPrefs: vi.fn(),
    ...initial,
  } as unknown as AppState;

  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState: (updater: AppState | ((s: AppState) => AppState)) => {
      const next =
        typeof updater === "function" ? (updater as (s: AppState) => AppState)(state) : updater;
      state = { ...state, ...next };
      for (const l of listeners) l(state);
    },
    subscribe: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    destroy: vi.fn(),
    getInitialState: vi.fn(),
  } as unknown as StoreApi<AppState> & { getState: () => AppState };
}

function makeTask(id: string, primarySessionId: string | null, workflowId = "wf1") {
  return {
    task_id: id,
    workflow_id: workflowId,
    workflow_step_id: "step1",
    title: "Test",
    description: "",
    state: "IN_PROGRESS",
    primary_session_id: primarySessionId,
    is_ephemeral: false,
  } as Record<string, unknown>;
}

function makeMessage(payload: Record<string, unknown>) {
  return {
    id: "msg-1",
    type: "notification" as const,
    action: "task.updated" as const,
    payload,
  } as Parameters<NonNullable<ReturnType<typeof registerTasksHandlers>["task.updated"]>>[0];
}

function makeDeletedMessage(payload: Record<string, unknown>) {
  return {
    id: "msg-1",
    type: "notification" as const,
    action: "task.deleted" as const,
    payload,
  } as Parameters<NonNullable<ReturnType<typeof registerTasksHandlers>["task.deleted"]>>[0];
}

function makeHandlers(store: ReturnType<typeof makeStore>, cachedPrimary: string | null) {
  const queryClient = makeQueryClient();
  queryClient.setQueryData(qk.tasks.detail("t1"), { primary_session_id: cachedPrimary });
  return registerTasksHandlers(store, queryClient);
}

describe("task.updated primary-session focus follow", () => {
  let store: ReturnType<typeof makeStore>;
  let setActiveSessionAuto: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActiveSessionAuto = vi.fn();
    vi.mocked(removeRecentTask).mockClear();
  });

  it("follows focus to the new primary when the user is on the previous primary", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: "sess-old",
        pinnedSessionId: null,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).toHaveBeenCalledTimes(1);
    expect(setActiveSessionAuto).toHaveBeenCalledWith("t1", "sess-new");
  });

  it("does NOT follow focus when the user is on a different session than the previous primary", () => {
    // User manually selected sess-other; primary swapping shouldn't yank them away.
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: SESS_OTHER,
        pinnedSessionId: SESS_OTHER,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });

  it("does NOT follow focus when the user is unpinned but not on the previous primary", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: SESS_OTHER,
        pinnedSessionId: null,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });

  it("does NOT follow focus when the user is viewing a different task", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t2",
        activeSessionId: "sess-old",
        pinnedSessionId: null,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });

  it("does NOT call setActiveSessionAuto when the primary did not change", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: "sess-old",
        pinnedSessionId: null,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-old")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });

  it("does NOT follow focus when the old primary is absent from the task cache", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: "sess-old",
        pinnedSessionId: null,
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = registerTasksHandlers(store, makeQueryClient());
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });
});

// Regression: even when the user happens to be sitting on the previous
// primary, an explicit pin on it must override primary-follow-focus —
// otherwise a workflow profile switch silently yanks them off the session
// they deliberately clicked into.
describe("task.updated primary-session focus follow (pinning)", () => {
  let store: ReturnType<typeof makeStore>;
  let setActiveSessionAuto: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActiveSessionAuto = vi.fn();
    vi.mocked(removeRecentTask).mockClear();
  });

  it("does NOT follow focus when the user has pinned the previous primary", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: "sess-old",
        pinnedSessionId: "sess-old",
        lastSessionByTaskId: {},
      },
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, "sess-old");
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });

  it("does NOT follow focus when active-session drift orphaned a non-terminal pin", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: SESS_DRIFTED,
        pinnedSessionId: SESS_PINNED,
        lastSessionByTaskId: {},
      },
      taskSessions: {
        items: {
          [SESS_PINNED]: { id: SESS_PINNED, task_id: "t1", state: "RUNNING" },
          [SESS_DRIFTED]: { id: SESS_DRIFTED, task_id: "t1", state: "COMPLETED" },
        },
      } as unknown as AppState["taskSessions"],
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, SESS_DRIFTED);
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).not.toHaveBeenCalled();
  });
});

describe("task.updated primary-session focus follow (stale pin cleanup)", () => {
  let store: ReturnType<typeof makeStore>;
  let setActiveSessionAuto: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setActiveSessionAuto = vi.fn();
    vi.mocked(removeRecentTask).mockClear();
  });

  it("clears a terminal orphaned pin when following focus to the new primary", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: SESS_DRIFTED,
        pinnedSessionId: SESS_PINNED,
        lastSessionByTaskId: {},
      },
      taskSessions: {
        items: {
          [SESS_PINNED]: { id: SESS_PINNED, task_id: "t1", state: "COMPLETED" },
          [SESS_DRIFTED]: { id: SESS_DRIFTED, task_id: "t1", state: "COMPLETED" },
        },
      } as unknown as AppState["taskSessions"],
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, SESS_DRIFTED);
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).toHaveBeenCalledWith("t1", "sess-new");
    expect(store.getState().tasks.pinnedSessionId).toBeNull();
  });

  it("clears a deleted orphaned pin when following focus to the new primary", () => {
    store = makeStore({
      tasks: {
        activeTaskId: "t1",
        activeSessionId: SESS_DRIFTED,
        pinnedSessionId: SESS_PINNED,
        lastSessionByTaskId: {},
      },
      taskSessions: {
        items: {
          [SESS_DRIFTED]: { id: SESS_DRIFTED, task_id: "t1", state: "COMPLETED" },
        },
      } as unknown as AppState["taskSessions"],
      taskSessionsByTask: {
        itemsByTaskId: {
          t1: [{ id: SESS_DRIFTED, task_id: "t1", state: "COMPLETED" }],
        },
        loadedByTaskId: { t1: true },
        loadingByTaskId: {},
      } as unknown as AppState["taskSessionsByTask"],
      setActiveSessionAuto,
    });

    const handlers = makeHandlers(store, SESS_DRIFTED);
    handlers["task.updated"]!(makeMessage(makeTask("t1", "sess-new")));

    expect(setActiveSessionAuto).toHaveBeenCalledWith("t1", "sess-new");
    expect(store.getState().tasks.pinnedSessionId).toBeNull();
  });
});

describe("task.updated Query-owned placement", () => {
  it("does not expose legacy kanban mirrors when tasks move workflows", () => {
    const store = makeStore();

    const handlers = registerTasksHandlers(store);
    handlers["task.updated"]!(
      makeMessage({ ...makeTask("t1", null, "wf2"), old_workflow_id: "wf1" }),
    );

    const state = store.getState();
    expect("kanban" in state).toBe(false);
    expect("kanbanMulti" in state).toBe(false);
  });
});

describe("task.deleted cleanup", () => {
  it("removes the deleted task from recent task history", () => {
    const store = makeStore({
      environmentIdBySessionId: {},
    });

    const handlers = registerTasksHandlers(store);
    handlers["task.deleted"]!(
      makeDeletedMessage({
        task_id: "t1",
        workflow_id: "wf1",
      }),
    );

    expect(removeRecentTask).toHaveBeenCalledTimes(1);
    expect(removeRecentTask).toHaveBeenCalledWith("t1");
  });

  it("removes the deleted task from lastSessionByTaskId", () => {
    const store = makeStore({
      tasks: {
        activeTaskId: null,
        activeSessionId: null,
        pinnedSessionId: null,
        lastSessionByTaskId: { t1: "sess-old", t2: SESS_OTHER },
      },
      environmentIdBySessionId: {},
    });

    const handlers = registerTasksHandlers(store);
    handlers["task.deleted"]!(makeDeletedMessage({ task_id: "t1", workflow_id: "wf1" }));

    const state = store.getState();
    expect(state.tasks.lastSessionByTaskId).not.toHaveProperty("t1");
    expect(state.tasks.lastSessionByTaskId).toHaveProperty("t2", SESS_OTHER);
  });

  it("does not expose legacy kanban mirrors when deleting tasks", () => {
    const store = makeStore({
      environmentIdBySessionId: {},
    });

    const handlers = registerTasksHandlers(store);
    handlers["task.deleted"]!(makeDeletedMessage({ task_id: "t1", workflow_id: "wf1" }));

    const state = store.getState();
    expect("kanban" in state).toBe(false);
    expect("kanbanMulti" in state).toBe(false);
  });
});
