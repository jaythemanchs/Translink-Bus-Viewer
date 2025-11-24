import { FeedEntity, getFeed } from "./proto.js"

if (navigator.serviceWorker) {
	navigator.serviceWorker.register("./service_worker.js")
}

const worker = new Worker("./web_worker.js")
const rad = Math.PI / 180

var url = new URL(location.href, location.origin)
var entities = {}

var stopTimes = {}
var shapes = {}
var stops = []
var trips = []
var lastVehicleFeed, lastPosition
var tempBusShape, tempBusMarker, tempBusStations, tempInterval, tempCurrentStation

const inboundBusIcon = L.icon({
	iconUrl: './images/bus_inbound.svg',
	iconSize: [29, 37],
	iconAnchor: [14.021, 37],
	popupAnchor: [0, -30]
});

const outbooundBusIcon = L.icon({
	iconUrl: './images/bus_outbound.svg',
	iconSize: [29, 37],
	iconAnchor: [14.021, 37],
	popupAnchor: [0, -30]
});

const busStationIcon = L.icon({
	iconUrl: './images/bus_station.svg',
	iconSize: [29 * 1.5, 37 * 1.5],
	iconAnchor: [14.021 * 1.5, 37 * 1.5],
	popupAnchor: [0, -30 * 1.5]
});

const locationMarker = L.marker()
const locationCircle = L.circle(null, {
	color: 'blue',
	opacity: 0.25,
	fillColor: 'rgba(0, 145, 255, 1)',
	fillOpacity: 0.25
})

const map = L.map('map', {
	maxZoom: 18,
	minZoom: 4,
	preferCanvas: false
}).fitWorld();

const layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
	attribution: '© OpenStreetMap'
}).addTo(map);

const searchInput = document.getElementById("searchinput")
const filterInput = document.getElementById("filterinput")
const controls = document.querySelector("#map>.leaflet-control-container")
const topLeftControls = controls.querySelector(".leaflet-top.leaflet-left")

const zoomGroup = topLeftControls.children[0]
const locateButton = createControlButton(zoomGroup)

locateButton.id = "locate"
locateButton.title = "Locate me"

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function to12Hr(t) {
	var h = t.slice(0, 2)
	return (h > 24 ? ("0" + h % 24) : h >= 22 ? (h - 12) : h > 12 ? "0" + (h - 12) : h) + t.slice(2) + (h >= 12 && h < 24 ? " PM" : "AM")
}

function distance(lat1, lon1, lat2, lon2) {
	return Math.asin(Math.sqrt(Math.sin((lat2 - lat1) * rad * 0.5) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad * 0.5) ** 2))
}

function replaceContractions(str) {
	return str.replace(/\brd\b|\bst\b|\bcr\b/gmi, (type) => {
		switch (type) {
			case "rd":
				return "road"
			case "st":
				return "street"
			case "cr":
				return "crescent"
		}
	})
}

function createControlGroup(parent) {
	const div = document.createElement("div")
	div.className = "leaflet-bar leaflet-control"
	parent.appendChild(div)
	return div
}

function createControlButton(parent) {
	const a = document.createElement("a")
	const span = document.createElement("span")

	a.href = "#"
	a.role = "button"
	a.ariaDisabled = false
	span.ariaHidden = true
	a.appendChild(span)
	parent.appendChild(a)

	return a
}

function updateTempBusShape(trip) {
	if (trip && lastVehicleFeed) {
		const shape = shapes[trip.shape_id]
		const currentStops = stopTimes[trip.trip_id]
		if (tempBusShape) updateTempBusShape()

		const points = shape.map((shape) => [Number(shape.shape_pt_lat), Number(shape.shape_pt_lon), shape.distance])
		var t = 0, last = new Date(), c, time, offset

		tempBusStations = currentStops.map((stopTime) => {
			c = stops.find((stop) => stop.stop_id == stopTime.stop_id)
			if (c) {
				time = new Date()
				time.setHours(...stopTime.arrival_time.split(":"))
				// c = L.marker([c.stop_lat, c.stop_lon], { icon: busStationIcon, zIndexOffset: 1000 }).addTo(map).popup = L.popup({ autoPan: false, content: `<b style="font-size:20px">${c.stop_name}</b><br>${stopTime.arrival_time == stopTime.departure_time ? `${offset = Math.floor((time - last) / 1000) < 0 ? `Arrived/Departed: ${Math.abs(offset)} seconds ago` : `Arriving/Departing In: ${offset}`} (${time.toLocaleTimeString(undefined, {timeStyle: "short"})})` : `Arrives: ${stopTime.arrival_time}<br>Departs: ${stopTime.departure_time}`}${stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}` })
				c = L.marker([c.stop_lat, c.stop_lon], { icon: busStationIcon, zIndexOffset: 1000 }).addTo(map)
				c.bindPopup(c.popup = L.popup({ autoPan: false, content: `<b style="font-size:20px">${c.stop_name}</b><br>${stopTime.arrival_time == stopTime.departure_time ? `Arrived/Departed: (${time.toLocaleTimeString(undefined, {timeStyle: "short"})})` : `Arrives: ${stopTime.arrival_time}<br>Departs: ${stopTime.departure_time}`}${stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}` }))
				c.stopName = stop.stop_name
				c.time = time
				return c
			}
		})
		tempBusMarker = L.marker([0, 0], { zIndexOffset: 1100 }).addTo(map)
		tempBusShape = L.polyline(shape.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: 'red' }).addTo(map);
		tempInterval = setInterval(() => {
			t = (t + 0.0001) % 1
			for (let point of points) {
				if (point[2] > t) {
					if (last) {
						c = (t - last[2]) / (point[2] - last[2])
						tempBusMarker.setLatLng([last[0] + (point[0] - last[0]) * c, last[1] + (point[1] - last[1]) * c])
						break
					} else tempBusMarker.setLatLng([point[0], point[1]])
				} else last = point
			}
		}, 10)

		map.once("click", () => updateTempBusShape())
		// tempInterval = setInterval(() => {
		// 	last = new Date()
		// 	tempBusStations.forEach((marker) => {
		// 		marker.setContent(`<b style="font-size:20px">${marker.stopName}</b><br>${marker.stopTime.arrival_time == marker.stopTime.departure_time ? `Arrives/Departs In: ${offset = Math.floor((marker.time - last) / 1000) < 0 ? `Arrived/Departed: ${Math.abs(offset)} seconds ago` : `Arriving/Departing In: ${offset}`} (${marker.time.toLocaleTimeString(undefined, {timeStyle: "short"})})` : `Arrives: ${marker.stopTime.arrival_time}<br>Departs: ${marker.stopTime.departure_time}`}${marker.stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}`)
		// 	})
		// }, 1000)
	} else {
		tempBusShape && tempBusShape.remove()
		tempBusMarker && tempBusMarker.remove()
		tempInterval && clearInterval(tempInterval)
		tempBusStations && tempBusStations.forEach((marker) => marker && marker.remove().popup.remove())
	}
}

function updateMarkers(vehicleFeed = lastVehicleFeed) {
	lastVehicleFeed = vehicleFeed
	if (vehicleFeed) {
		const routes = filterInput.value.split(",").map((route) => route.trim())
		Object.keys(entities).forEach((value) => {
			if (entities[value] && (!vehicleFeed.entities[value] || ((routes[0].length > 0 && !routes.includes(vehicleFeed.entities[value].vehicle.tripDescriptor.routeId.split("-")[0]))))) {
				entities[value].marker.remove()
				entities[value].popup.remove()
				entities[value] = null
			}
		})
		Object.keys(vehicleFeed.entities).forEach((value) => {
			/**
			 * @type {FeedEntity}
			 */
			const entity = vehicleFeed.entities[value]
			const vehicle = entity.vehicle
			var store, popup, trip, stop
			if (vehicle) {
				const route = vehicle.tripDescriptor.routeId.split("-")[0]
				const position = vehicle.position
				if (position && (routes[0].length == 0 || routes.includes(route))) {
					store = entities[value]
					if (store) {
						trip = trips.find((value) => value.trip_id == vehicle.tripDescriptor.tripId)
						stop = stops.find((value) => value.stop_id == vehicle.stopId)
						if (!trip || !stop) return
						store.marker.setLatLng([position.latitude, position.longitude])
						switch (vehicle.status) {
							case "Stopped":
								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Stopped At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
							case "Departed":
								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Next Stop: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
							case "Arriving":
								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Arriving At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
						}

					} else {
						trip = trips.find((value) => value.trip_id == vehicle.tripDescriptor.tripId)
						stop = stops.find((value) => value.stop_id == vehicle.stopId)
						if (!trip || !stop) return
						store = {
							popup: popup = L.popup({ autoPan: false }).setContent(`<b style="font-size:20px">${route}</b><br>Status: ${vehicle.status}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}<br>${stop.stop_name}`),
							marker: L.marker([position.latitude, position.longitude], { icon: trip.direction_id == 0 ? inboundBusIcon : outbooundBusIcon, autoPanOnFocus: false }).bindPopup(popup).on("popupopen", () => updateTempBusShape(trip)).addTo(map)
						}
						switch (vehicle.status) {
							case "Stopped":
								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Stopped At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
							case "Departed":
								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Next Stop: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
							case "Arriving":
								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Arriving At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
								break
						}
						entities[value] = store
					}
				}
			}
		})
	}
}

function updateFeeds() {
	getFeed("https://api.codetabs.com/v1/proxy/?quest=https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus").then(updateMarkers)
}

{
	let initialPosition = url.searchParams.get("pos")
	if (initialPosition && (initialPosition = initialPosition.split(",")).length == 2) {
		map.setView(initialPosition.map(Number), Number(url.searchParams.get("z")) || 16, { animate: false })
		map.locate({ setView: false, maxZoom: 16 })
	} else {
		map.locate({ setView: true, maxZoom: 16 })
	}
}

function searchResult(inner, distance) {
	const result = document.createElement("div")
	result.innerHTML = inner
	searchInput.parentElement.append(result)
	return result
}

function search(query) {
	Array.from(searchInput.parentElement.children).forEach((child) => {
		if (child.tagName == "DIV") child.remove()
	})

	if (query.length > 0) {
		searchInput.parentElement.classList.add("open")
		var results = 0

		if (lastPosition) {
			results = []
			for (let stop of stops) {
				if (replaceContractions(stop.stop_name.toLowerCase()).includes(query)) {
					stop.distance = distance(stop.stop_lat, stop.stop_lon, lastPosition.lat, lastPosition.lng)
					results.push(stop)
				}
				if (results.length > 100) break
			}

			results = results.sort((a, b) => a.distance - b.distance)
			
			results.forEach((stop) => searchResult(stop.stop_name + " - <b>" + (stop.distance * 12742).toFixed(2) + "km</b>", ).addEventListener("click", () => {
				L.popup([stop.stop_lat, stop.stop_lon], { content: `<b style="font-size:20px">${stop.stop_name}</b>`, autoPan: false }).openOn(map.flyTo([stop.stop_lat, stop.stop_lon])).temp = true
			}))
		} else {
			for (let stop of stops) {
				if (replaceContractions(stop.stop_name.toLowerCase()).includes(query)) {
					searchResult(stop.stop_name).addEventListener("click", () => {
						L.popup([stop.stop_lat, stop.stop_lon], { content: `<b style="font-size:20px">${stop.stop_name}</b>`, autoPan: false }).openOn(map.flyTo([stop.stop_lat, stop.stop_lon])).temp = true
					})
					results++
				}
				if (results > 100) break
			}
		}
	} else {
		searchInput.parentElement.classList.remove("open")
	}
}

map.on("moveend", () => {
	const pos = map.getCenter()
	url.searchParams.set("pos", pos.lat + "," + pos.lng)
	url.searchParams.set("z", map.getZoom())
	history.pushState(null, '', url)
})

map.on("popupclose", (event) => {
	if (event.popup.temp) {
		event.popup.temp = null
		event.popup.remove()
	}
})

map.on("locationfound", (event) => {
	lastPosition = event.latlng
	locationMarker.setLatLng(event.latlng)
	locationMarker.addTo(map)
	locationCircle.setLatLng(event.latlng)
	locationCircle.setRadius(event.accuracy)
	locationCircle.addTo(map)
})

map.on("locationerror", (event) => alert(`Failed to obtain current location: ${event.code} - ${event.message}`))

searchInput.addEventListener("input", () => search(replaceContractions(searchInput.value.trim().toLowerCase())))
filterInput.addEventListener("input", () => updateFeeds())
locateButton.addEventListener("click", () => map.locate({ setView: true, maxZoom: 16 }))

worker.onmessage = (data) => {
	if (data.data == "complete") {
		const openRequest = indexedDB.open("gtfsDB")
		openRequest.onerror = (event) => alert(`Failed to open GTFS DB: ${event.code} - ${event.message}`)
		openRequest.onupgradeneeded = (event) => event.target.result.createObjectStore("files", { keyPath: "name" })
		openRequest.onsuccess = () => {
			var primaryTransaction = openRequest.result.transaction("files", "readonly")
			primaryTransaction.onerror = (event) => alert(`Failed to start GTFS DB Transaction: ${event.code} - ${event.message}`)

			var primaryResult = primaryTransaction.objectStore("files").openCursor()
			primaryResult.onerror = (event) => alert(`Failed to query GTFS DB: ${event.code} - ${event.message}`)
			primaryResult.onsuccess = async () => {
				if (primaryResult.result) {
					switch (primaryResult.result.primaryKey) {
						case "stops":
							stops = primaryResult.result.value.data
							break
						case "stop_times":
							stopTimes = primaryResult.result.value.data
							break
						case "shapes":
							shapes = primaryResult.result.value.data
							break
						case "trips":
							trips = primaryResult.result.value.data
							break
					}
					primaryResult.result.continue()
				} else {
					updateFeeds()
					setInterval(updateFeeds, 20000)
				}
			}
		}
	}
}