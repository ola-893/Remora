import { Workflow, BookOpen } from 'lucide-react';

export const navigation = [
  { path: window.__AGENTSTREAMS_RECORDED_ONLY__ ? '/' : '/workflow', icon: Workflow, label: 'Workflow', shortLabel: 'Workflow' },
  { path: '/docs', icon: BookOpen, label: 'Docs', shortLabel: 'Docs' },
];
export const isCurrentPage = (path, pathname) =>
  path === '/'
    ? pathname === '/'
    : pathname === path || pathname.startsWith(`${path}/`);
