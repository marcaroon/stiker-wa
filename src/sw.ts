/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: any };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Android share sheet → POST /share-target (see manifest share_target).
// Stash the payload in a cache, then redirect to the app which picks it up.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShare(event.request));
  }
});

async function handleShare(req: Request) {
  try {
    const fd = await req.formData();
    const cache = await caches.open('share-inbox');
    const file = fd.get('media');
    const meta: Record<string, string> = {
      title: String(fd.get('title') ?? ''),
      text: String(fd.get('text') ?? ''),
      url: String(fd.get('url') ?? ''),
    };
    if (file instanceof File && file.size > 0) {
      meta.fileName = file.name;
      meta.fileType = file.type;
      await cache.put('/_share/file', new Response(file, { headers: { 'content-type': file.type || 'application/octet-stream' } }));
    } else {
      await cache.delete('/_share/file');
    }
    await cache.put('/_share/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  } catch (e) {
    console.error('share-target', e);
  }
  return Response.redirect('/?shared=1', 303);
}

registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html'), { denylist: [/^\/api\//, /^\/share-target/] }));
