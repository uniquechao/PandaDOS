import { useEffect, useRef, useState } from 'preact/hooks';
import { ISSUE_LIST_PAGE_SIZE, type IssueListGroup, type IssueListPage } from '../../../shared/issue-list';
import { api } from './api';
import { createIssueListPolling, type IssueListState } from './issueListPolling';

export function useIssueList(pid: number, group: IssueListGroup, page: number, query: string) {
  const [state, setState] = useState<IssueListState>({ data: null, busy: true, error: null });
  const poll = useRef<ReturnType<typeof createIssueListPolling> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setState({ data: null, busy: true, error: null });
    const params = new URLSearchParams({ view: 'summary', group, page: String(page),
      pageSize: String(ISSUE_LIST_PAGE_SIZE), q: debouncedQuery });
    const current = createIssueListPolling({
      read: signal => api<IssueListPage>(`/api/projects/${pid}/issues?${params}`, 'GET', undefined, { signal }),
      onState: setState,
      visible: () => document.visibilityState !== 'hidden',
    });
    poll.current = current;
    const onVisibility = () => { if (document.visibilityState !== 'hidden') void current.refresh(); };
    document.addEventListener('visibilitychange', onVisibility);
    void current.refresh();
    return () => {
      current.stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pid, group, page, debouncedQuery]);
  return { ...state, refresh: () => poll.current?.refresh() };
}
