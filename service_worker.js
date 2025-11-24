self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open("siteCache").then((cache) => {
			return cache.addAll([
				"/index.html",
				"/index.js",
				"/proto.js",
				"/zip.js",
				"/leaflet.css",
				"/leaflet.js",
				"/papaparse.min.js",
				"/web_worker.js",
				"/service_worker.js",
				"/awesome.woff2",
				"/SEQ_GTFS.zip",
				"/manifest.webmanifest",
				"/images/favicon_192x192.png",
				"/images/favicon_512x512.png",
				"/images/favicon_monochrome_512x512.png",
				"/images/layers-2x.png",
				"/images/layers.png",
				"/images/marker-icon-2x.png",
				"/images/marker-icon.png",
				"/images/marker-shadow.png",
				"/images/bus_inbound.svg",
				"/images/bus_outbound.svg",
				"/images/bus_station.svg",
				"/"
			]);
		})
	);
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url)
	if (url.hostname == location.hostname && url.pathname == "/") {
		event.respondWith(
			caches.match(url.origin).then((cachedResponse) => {
				return cachedResponse || fetch(event.request);
			})
		)
	} else if (url.hostname != "gtfsrt.api.translink.com.au") {
		event.respondWith(
			caches.match(event.request.url).then((cachedResponse) => {
				return cachedResponse || fetch(event.request);
			})
		);
	}
});