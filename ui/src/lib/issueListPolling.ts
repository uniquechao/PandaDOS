import type { IssueListPage } from '../../../shared/issue-list';

export interface IssueListState {
  data: IssueListPage | null;
  busy: boolean;
  error: string | null;
}

/** One request per group. The next poll is scheduled only after body parsing settles. */
export function createIssueListPolling(opts: {
  read: (signal: AbortSignal) => Promise<IssueListPage>;
  onState: (state: IssueListState) => void;
  visible?: () => boolean;
  intervalMs?: number;
  timeoutMs?: number;
}) {
  let state: IssueListState = { data: null, busy: false, error: null };
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const publish = () => { if (!stopped) opts.onState({ ...state }); };
  const schedule = () => {
    if (!stopped) timer = setTimeout(() => { void refresh(); }, opts.intervalMs ?? 5000);
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    clearTimeout(timer);
    if (opts.visible && !opts.visible()) { schedule(); return Promise.resolve(); }
    controller = new AbortController();
    state = { ...state, busy: true };
    publish();
    const signal = controller.signal;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        controller?.abort();
        reject(new Error('TimeoutError'));
      }, opts.timeoutMs ?? 15000);
    });
    inFlight = Promise.race([Promise.resolve().then(() => opts.read(signal)), timeout])
      .then(data => {
        if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) ||
            !Number.isSafeInteger(data.page) || data.page < 1 || data.total < 0 ||
            (data.pageSize !== null && (!Number.isSafeInteger(data.pageSize) || data.pageSize < 1))) {
          throw new Error('InvalidIssueListResponse');
        }
        state = { data, busy: false, error: null };
      })
      .catch((error: unknown) => {
        state = { ...state, busy: false, error: error instanceof Error ? error.message : String(error) };
      })
      .finally(() => {
        clearTimeout(deadline);
        inFlight = null;
        publish();
        schedule();
      });
    return inFlight;
  };
  return {
    refresh,
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      controller?.abort();
    },
  };
}
