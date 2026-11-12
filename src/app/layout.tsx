import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Central de Mandados SJP — Mapa Inteligente & Triagem Territorial (TJPR)',
  description:
    'Sistema inteligente de distribuição territorial, conferência por coordenadas, CEP, rodovias por km e triagem de mandados para São José dos Pinhais e Tijucas do Sul (Regiões 1 a 9).',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans antialiased overflow-hidden">{children}</body>
    </html>
  );
}
