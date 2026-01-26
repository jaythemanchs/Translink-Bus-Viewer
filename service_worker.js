self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open("siteCache").then((cache) => {
			return cache.addAll([
				"./",
				"./index.html",
				"./service_worker.js",
				"./manifest.webmanifest",
				"./js/index.js",
				"./js/proto.js",
				"./js/leaflet.js",
				"./js/web_worker.js",
				"./js/bootstrap.bundle.min.js",
				"./css/leaflet.css",
				"./css/bootstrap.min.css",
				"./css/bootstrap-icons.min.css",
				"./fonts/awesome.woff2",
				"./fonts/bootstrap-icons.woff",
				"./fonts/bootstrap-icons.woff2",
				"./images/icon.svg",
				"./images/icon_safe.svg",
				"./images/icon_color.svg",
				"./images/icon_48x48.png",
				"./images/icon_72x72.png",
				"./images/icon_96x96.png",
				"./images/icon_128x128.png",
				"./images/icon_192x192.png",
				"./images/icon_192x192_color.png",
				"./images/icon_384x384.png",
				"./images/icon_512x512.png",
				"./images/icon_512x512_color.png",
				"./images/icon_512x512_monochrome.png",
				"./images/layers.png",
				"./images/layers-2x.png",
				"./images/marker-icon.png",
				"./images/marker-icon-2x.png",
				"./images/marker-shadow.png",
				"./images/realtime.svg",
				"./images/bus_inner.svg",
				"./images/bus_station.svg",
				"./images/bus_inbound.svg",
				"./images/bus_outbound.svg",
				"./images/bus_outer_inbound.svg",
				"./images/bus_outer_outbound.svg"
			])
		}).then(() => self.clients.matchAll({ includeUncontrolled: true }).then((clients) => {
			clients.forEach((client) => client.postMessage("cached"))
		}))
	)
})

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url)
	if (url.pathname == "/" && url.origin == location.origin) {
		event.respondWith(
			caches.match(url.origin).then((cachedResponse) => {
				return cachedResponse || fetch(event.request)
			})
		)
	}
	else if (url.hostname != "gtfsrt.api.translink.com.au") {
		event.respondWith(
			caches.match(event.request, { ignoreVary: true }).then((cachedResponse) => {
				return cachedResponse || fetch(event.request)
			})
		)
	}
})