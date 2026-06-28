import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/lib/query/keys";
import type { TaskPlan } from "@/lib/types/http";
import { useTaskPlan } from "./use-task-plan";

const apiMocks = vi.hoisted(() => ({
  createTaskPlan: vi.fn(),
  deleteTaskPlan: vi.fn(),
  getPlanRevision: vi.fn(),
  getTaskPlan: vi.fn(),
  listPlanRevisions: vi.fn(),
  revertPlanRevision: vi.fn(),
  updateTaskPlan: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  connection: { status: "connected" },
  taskPlans: {
    previewRevisionIdByTaskId: {},
    comparePairByTaskId: {},
  },
  hydrateTaskPlanLastSeen: vi.fn(),
  markTaskPlanSeen: vi.fn(),
  setPreviewRevision: vi.fn(),
  toggleComparePair: vi.fn(),
  clearComparePair: vi.fn(),
}));

vi.mock("@/lib/api/domains/plan-api", () => apiMocks);
vi.mock("@/components/state-provider", () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    id: "plan-1",
    task_id: "task-1",
    title: "Plan",
    content: "# Plan",
    created_by: "user",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listPlanRevisions.mockResolvedValue([]);
});

describe("useTaskPlan", () => {
  it("forces explicit plan refetches past the stale window", async () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData(qk.taskPlan.detail("task-1"), makePlan({ content: "# Cached" }));
    queryClient.setQueryData(qk.taskPlan.revisions("task-1"), []);
    apiMocks.getTaskPlan.mockResolvedValue(makePlan({ content: "# Fresh" }));

    const { result } = renderHook(() => useTaskPlan("task-1"), {
      wrapper: wrapperFor(queryClient),
    });

    await waitFor(() => expect(result.current.plan?.content).toBe("# Cached"));
    await act(async () => {
      await result.current.refetch();
    });

    expect(apiMocks.getTaskPlan).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryData(qk.taskPlan.detail("task-1"))).toMatchObject({
      content: "# Fresh",
    });
    expect(storeState.markTaskPlanSeen).toHaveBeenCalledWith("task-1", "2026-06-24T00:00:00Z");
  });
});
