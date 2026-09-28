import type { Metadata } from 'next';
import { Inter, Outfit } from 'next/font/google';
import { SessionIdleGuard } from '@/components/auth/SessionIdleGuard';
import './globals.css';

const display = Outfit({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const sans = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Classroom — Live Online Teaching',
  description:
    'Premium live classes with selective student video, screen share with annotations, and privacy-minded bandwidth controls.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${display.variable} ${sans.variable} font-sans antialiased min-h-screen`}>
        <SessionIdleGuard />
        {children}
      </body>
    </html>
  );
}
