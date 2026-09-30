export type RoomIconName = 'back' | 'goal' | 'artifacts' | 'sources' | 'budget' | 'team' | 'panels' | 'send' | 'more' | 'plus' | 'down';
const paths: Record<RoomIconName, string> = {
  back: 'M14 5 7 12l7 7',
  goal: 'M21 11a9 9 0 1 1-8-8 M17 3v4h4 M17 7l-5 5 M16 12a4 4 0 1 1-4-4',
  artifacts: 'M6 3h9l4 4v14H6z M14 3v5h5 M9 12h7 M9 16h7',
  sources: 'M3 6h7l2 3h9v11H3z',
  budget: 'M12 3v9h9 M9 4a9 9 0 1 0 11 11 M15 3a9 9 0 0 1 6 6h-6z',
  team: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 4a4 4 0 0 1 0 7 M22 21v-2a4 4 0 0 0-3-3.9',
  panels: 'M3 4h18v16H3z M15 4v16',
  send: 'm3 3 18 9-18 9 4-9-4-9 M7 12h14',
  more: 'M4 12h.01 M12 12h.01 M20 12h.01',
  plus: 'M12 5v14 M5 12h14',
  down: 'M12 3v17 M5 13l7 7 7-7',
};
export function RoomIcon({ name }: { name: RoomIconName }) {
  return <svg class="room-line-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={name === 'more' ? 3.5 : 1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
