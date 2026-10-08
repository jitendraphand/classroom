import type { Metadata, Viewport } from 'next';
import { Inter, Outfit } from 'next/font/google';
import { SessionIdleGuard } from '@/components/auth/SessionIdleGuard';
import { StaffSessionGuard } from '@/components/auth/StaffSessionGuard';
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
    'Premium live classes with selective student video, screen share, and privacy-minded bandwidth controls.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
  },
};

/** Same viewport on every phone/tablet/desktop browser; notch areas handled with safe-area insets. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
  themeColor: '#05060a',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`${display.variable} ${sans.variable} font-sans antialiased min-h-screen`}>
        <SessionIdleGuard />
        {children}
        <StaffSessionGuard />
      </body>
    </html>
  );
}
