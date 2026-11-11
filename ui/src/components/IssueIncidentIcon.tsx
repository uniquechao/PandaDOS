const paths={
  close:'m6 6 12 12M18 6 6 18',
  branch:'M6 7v10m2-6h5a5 5 0 0 0 5-3M4 5a2 2 0 1 0 4 0 2 2 0 0 0-4 0M16 6a2 2 0 1 0 4 0 2 2 0 0 0-4 0M4 19a2 2 0 1 0 4 0 2 2 0 0 0-4 0',
  check:'m5 12 4 4L19 6',
  shield:'m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Zm-4 9 3 3 5-6',
  chevron:'m9 5 7 7-7 7',
  evidence:'M7 3h7l4 4v14H6V3h1Zm7 0v5h5M9 12h6m-6 4h6',
  tools:'m14 7 3 3m-8 4L4 19l1 1 5-5m4-12 4 1-3 4 2 2 4-3 1 4-4 4-5-1-3 3-3-3 3-3-1-5 4-4Z',
  refresh:'M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1',
  assistant:'M8 7h8a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-5a4 4 0 0 1 4-4Zm4-4v4m-3 5v2m6-2v2m-6 3h6',
  send:'M12 19V5m-6 6 6-6 6 6',
  save:'M5 5h14v14H5zM9 5v6h6V5M9 19v-5h6v5',
  stop:'M6 6h12v12H6z',
  alert:'M12 8v5m0 4h.01M10 4 2 19h20L14 4a2 2 0 0 0-4 0Z',
} as const;
export function IssueIncidentIcon({name}:{name:keyof typeof paths}) {
  return <svg class="incident-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
