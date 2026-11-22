import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans' });

export const metadata: Metadata = {
  title: 'WARAGA Admin',
  description: 'WARAGA (Barasilian Hand) — admin panel for staff',
  robots: { index: false, follow: false }, // keep the panel out of search engines
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{
            duration: 4000,
            style: {
              fontSize: '0.8125rem',
              borderRadius: '10px',
              boxShadow: '0 4px 12px rgba(0,0,0,.12)',
            },
          }}
        />
      </body>
    </html>
  );
}
