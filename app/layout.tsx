import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DepositCheck',
  description: 'Check whether a rental listing photo belongs to the address it claims.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
