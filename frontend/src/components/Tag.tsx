import { ReactNode } from 'react';

type TagColor = 'green' | 'red' | 'amber' | 'gray';

export default function Tag({ color, children }: { color: TagColor; children: ReactNode }) {
  return <span className={`tag ${color}`}>{children}</span>;
}
