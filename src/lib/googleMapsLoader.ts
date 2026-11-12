let loadedKey: string | null = null;
let loadPromise: Promise<typeof google> | null = null;

export function loadGoogleMapsApi(apiKey: string): Promise<typeof google> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Google Maps só pode ser carregado no navegador'));
  }

  if (window.google?.maps && loadedKey === apiKey) {
    return Promise.resolve(window.google);
  }

  if (loadPromise && loadedKey === apiKey) {
    return loadPromise;
  }

  // If switching key, clean previous script tags cleanly
  const existing = document.getElementById('gmaps-js-sdk');
  if (existing && loadedKey !== apiKey) {
    existing.remove();
    loadPromise = null;
  }

  loadedKey = apiKey;
  loadPromise = new Promise((resolve, reject) => {
    const callbackName = '__initGmapsSJP';
    const w = window as unknown as Record<string, unknown>;

    w.gm_authFailure = () => {
      loadPromise = null;
      reject(new Error('Chave da Google Maps API inválida ou sem permissão/faturamento para Maps JavaScript API.'));
    };

    w[callbackName] = () => {
      if (window.google?.maps) {
        resolve(window.google);
      } else {
        reject(new Error('Falha ao inicializar google.maps'));
      }
    };

    const script = document.createElement('script');
    script.id = 'gmaps-js-sdk';
    script.async = true;
    script.defer = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      apiKey
    )}&language=pt-BR&region=BR&callback=${callbackName}`;
    script.onerror = () => {
      loadPromise = null;
      reject(new Error('Erro de rede ao carregar Google Maps JS API'));
    };
    document.head.appendChild(script);
  });

  return loadPromise;
}
