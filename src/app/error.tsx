'use client';

import React, { useEffect } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    const msg = String(error?.message || '');
    const isChunkErr =
      error?.name === 'ChunkLoadError' ||
      /Loading chunk|CSS chunk|dynamically imported module|Failed to fetch/i.test(msg);
    if (isChunkErr && typeof window !== 'undefined') {
      try {
        const key = 'sjp_chunk_reload_once';
        if (!window.sessionStorage.getItem(key)) {
          window.sessionStorage.setItem(key, '1');
          window.location.reload();
        }
      } catch {
        // Ignore sessionStorage failures
      }
    }
  }, [error]);

  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 p-6 text-center gap-4">
      <div className="w-12 h-12 rounded-2xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center">
        <AlertTriangle className="w-6 h-6 text-rose-400" />
      </div>
      <div className="max-w-md space-y-1.5">
        <h2 className="text-base font-bold text-white">Falha ao carregar o painel</h2>
        <p className="text-xs text-slate-400 leading-relaxed">
          Ocorreu uma interrupção momentânea ao carregar os arquivos do mapa. Clique abaixo para
          recarregar a página.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700 transition"
        >
          Tentar novamente
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-xs font-bold text-white transition"
        >
          <RotateCw className="w-3.5 h-3.5" />
          Recarregar página
        </button>
      </div>
    </div>
  );
}
