const alertsPane = document.getElementById("alerts")
if (typeof Worker == "undefined") {
	createAlert("danger", "This browser does not support WebWorkers")
	document.getElementById("main_search").parentElement.classList.remove("loading")
	throw new Error("WebWorkers not supported!")
}

if (typeof navigator.storage == "undefined") {
	createAlert("danger", "This browser does not support WebStorage")
	document.getElementById("main_search").parentElement.classList.remove("loading")
	throw new Error("WebStorage not supported!")
}

if (!localStorage.getItem("favourite_stops")) localStorage.setItem("favourite_stops", "[]")
if (!localStorage.getItem("favourite_routes")) localStorage.setItem("favourite_routes", "[]")
if (!localStorage.getItem("favourite_route_filters")) localStorage.setItem("favourite_route_filters", "[]")
if (navigator.serviceWorker) {
	navigator.serviceWorker.register("./service_worker.js")
	navigator.serviceWorker.onmessage = (message) => {
		if (message.data == "cached") {
			createAlert("success", "This program can now run offline", true)
		}
	}
}

const worker = new Worker("./js/web_worker.js")
const rad = Math.PI / 180

const routeTypes = {
	[0]: "bi-train-lightrail-front-fill",
	[1]: "bi-train-lightrail-front-fill",
	[2]: "bi-train-front-fill",
	[3]: "bi-bus-front-fill",
	[4]: "bi-life-preserver",
	[5]: "bi-train-lightrail-front-fill",
	[11]: "bi-bus-front-fill",
	[12]: "bi-train-lightrail-front-fill"
}

const badgeColours = {
	"Space available": "success",
	"Some space available": "warning",
	"Limited space available": "danger"
}

var url = new URL(location.href, location.origin)
var vehiclePositionMarkers = {}
var tempBusShape, lastPosition, lastRouteId, lastDropdownLi, currentRouteDirection
var workerReady = false
var mapDebounce = false
var loadingCount = 1

const BusMarker = L.DivOverlay.extend({
	_latlng: [0, 0],
	initialize: function (options) {
		L.setOptions(this, {
			...options,
			interactive: false,
			pane: "markerPane"
		})
	},
	_initLayout: function () {
		const container = this._container = L.DomUtil.create("div", "bus-marker leaflet-marker-icon leaflet-zoom-animated")
		container.setAttribute("role", "tooltip")
		container.innerHTML =
			"<img src=\"./images/bus_outer_inbound.svg\" width=\"29\" aria-hidden=\"true\"><img src=\"./images/bus_inner.svg\" width=\"29\" aria-hidden=\"true\">" +
			"<div><p></p><p></p></div>"
		container.onclick = this._onclick.bind(this)
		container.onmousemove = (() => this.moved = true).bind(this)
		container.onmousedown = (() => this.moved = false).bind(this)
	},
	_updateLayout: function () { },
	_setPosition: function (pos) { L.DomUtil.setPosition(this._container, pos.subtract([14, 37])) },
	_updatePosition: function () { this._setPosition(this._map.latLngToLayerPoint(this._latlng)) },
	_animateZoom: function (e) { this._setPosition(this._map._latLngToNewLayerPoint(this._latlng, e.zoom, e.center)) },
	_adjustPan: function () { },
	_onclick: function (event) {
		if (!this.moved) {
			event.stopPropagation()
			event.preventDefault()
			worker.postMessage({ command: "vehicle_timetable", id: this.vehicleId }, true)
		}
	},
	setRT: function (rtInfo) {
		var container = this._container
		if (rtInfo.direction == 1) {
			container.children[0].src = "./images/bus_outer_outbound.svg"
			container.classList.add("outbound")
		} else {
			container.children[0].src = "./images/bus_outer_inbound.svg"
			container.classList.remove("outbound")
		}

		container.children[0].style.rotate = (rtInfo.rotation || 0) + "rad"
		container = container.children[2].children
		container[0].innerText = rtInfo.route
		if (rtInfo.delay != undefined) {
			(container = container[1]).innerText = rtInfo.delay
			container.className = rtInfo.delay > 0 ? "text-danger" : "text-success"
			container.hidden = false
		} else container[1].hidden = true
		this.vehicleId = rtInfo.id
		this.routeId = rtInfo.routeId
		this.direction = rtInfo.direction
		this.setLatLng(rtInfo.position)
		this.setOpacity(!lastRouteId || (rtInfo.routeId == lastRouteId && rtInfo.direction == currentRouteDirection) ? 1 : 0)
		return this
	},
	setOpacity: function (opacity) {
		this._container.style.opacity = opacity
		this._container.hidden = !opacity
	}
})

const inboundBusIcon = L.icon({
	iconUrl: "./images/bus_inbound.svg",
	iconSize: [29, 37],
	iconAnchor: [14.021, 37],
	popupAnchor: [0, -30]
})

const outbooundBusIcon = L.icon({
	iconUrl: "./images/bus_outbound.svg",
	iconSize: [29, 37],
	iconAnchor: [14.021, 37],
	popupAnchor: [0, -30]
})

const busStationIcon = L.icon({
	iconUrl: "./images/bus_station.svg",
	iconSize: [29 * 1.5, 37 * 1.5],
	iconAnchor: [14.021 * 1.5, 37 * 1.5],
	popupAnchor: [0, -30 * 1.5]
})

const locationCircle = L.circle(null, {
	color: "blue",
	opacity: 0.125,
	fillColor: "rgba(0, 145, 255, 1)",
	fillOpacity: 0.125
})

const locationMarker = L.circleMarker(null, {
	color: "white",
	opacity: 1,
	fillColor: "rgba(0, 145, 255, 1)",
	fillOpacity: 1,
	radius: 6,
	weight: 2
})

const map = L.map("map", {
	maxZoom: 20,
	minZoom: 1,
	preferCanvas: false
}).fitWorld()

const layer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
	maxNativeZoom: 19,
	minNativeZoom: 1,
	maxZoom: 20,
	minZoom: 1,
	attribution: "© OpenStreetMap"
}).addTo(map)

const searchInput = document.getElementById("main_search")
const routeFilterInput = document.getElementById("route_filter")
const addFavouriteRouteFilterButton = document.getElementById("add_favourite_route")
const favouriteRouteFiltersList = document.getElementById("route_filter_favourites")
const filterMapButton = document.getElementById("filter_map")

const routePane = document.getElementById("route_pane")
const routePaneCode = document.getElementById("route_code")
const routePaneName = document.getElementById("route_name")
const routePaneInbound = document.getElementById("inbound_tab")
const routePaneOutbound = document.getElementById("outbound_tab")
const routePaneTimetable = document.getElementById("timetable")

const controls = document.querySelector("#map>.leaflet-control-container")
const topLeftControls = controls.querySelector(".leaflet-top.leaflet-left")

const footerNavbar = document.querySelector("body>ul")

const zoomGroup = topLeftControls.children[0]
const locateButton = createControlButton(zoomGroup)

const mainResultsDropdown = new bootstrap.Dropdown(document.getElementById("main_search_results"), {
	offset: [0, 0],
	display: "static"
})

locateButton.id = "locate"
locateButton.title = "Locate me"

const _postMessage = worker.postMessage
worker.postMessage = (message, tick) => {
	if (tick) {
		tickLoading(1)
		_postMessage.call(worker, { ...message, tick: true })
	} else _postMessage.call(worker, message)
}

const _fitBounds = map.fitBounds
map.fitBounds = (bounds) => {
	if (innerWidth >= 724 && innerHeight >= 577) if (routePane.classList.contains("mini")) {
		_fitBounds.call(map, bounds, { paddingTopLeft: [45, 0], paddingBottomRight: [0, footerNavbar.clientHeight + routePane.clientHeight + parseFloat(getComputedStyle(document.documentElement).fontSize) * 3] })
	} else {
		_fitBounds.call(map, bounds, { paddingTopLeft: [routePane.clientWidth + 45, 0], paddingBottomRight: [0, footerNavbar.clientHeight + parseFloat(getComputedStyle(document.documentElement).fontSize)] })
	}
	else _fitBounds.call(map, bounds, { paddingTopLeft: [45, 0] })
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function to12Hr(t) {
	var h = t.slice(0, 2)
	return (h > 24 ? ("0" + h % 24) : h >= 22 ? (h - 12) : h > 12 ? "0" + (h - 12) : h) + t.slice(2) + (h >= 12 && h < 24 ? " PM" : " AM")
}

function timetable12Hr(t) {
	var h = t.slice(0, 2)
	return (h > 24 ? (h % 24) : h > 12 ? (h - 12) : h) + t.slice(2, 5) + (t.slice(6, 8) != "AA" ? "" : t.slice(5, 8)) + (h >= 12 && h < 24 ? " PM" : " AM")
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

function tickLoading(offset) {
	loadingCount += offset
	if (loadingCount > 0) mainResultsDropdown._element.parentElement.classList.add("loading")
	else {
		loadingCount = 0
		mainResultsDropdown._element.parentElement.classList.remove("loading")
	}
}

function createAlert(type, inner, closable) {
	const div = document.createElement("div")
	div.role = "alert"
	div.className = "alert alert-dismissible show fade alert-" + type
	div.innerHTML = inner + (closable ? "<button type=\"button\" class=\"btn-close\" data-bs-dismiss=\"alert\" aria-label=\"Close\"></button>" : "")
	alertsPane.prepend(div)
	return div
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

function searchResult(inner, favouriteKey, favouriteValue) {
	const result = document.createElement("li")
	result.innerHTML = "<a class=\"dropdown-item small d-flex flex-grow-1\" href=\"#\">" + inner + "</a>"
	if (favouriteKey && favouriteValue) {
		const button = document.createElement("button")
		button.className = "bg-transparent border-0 small ps-2 pe-0"
		button.type = "button"
		button.title = "Add Favourite"
		button.innerHTML = "<span class=\"bi bi-star" + (JSON.parse(localStorage.getItem(favouriteKey))?.includes(favouriteValue) ? "-fill" : "") + " small\" aria-hidden=\"true\"></span>"
		button.onclick = (event) => {
			event.stopPropagation()
			event.preventDefault()
			const list = JSON.parse(localStorage.getItem(favouriteKey)) || []
			const index = list.indexOf(favouriteValue)
			if (index >= 0) {
				button.firstChild.classList.remove("bi-star-fill")
				button.firstChild.classList.add("bi-star")
				list.splice(index, 1)
			} else {
				button.firstChild.classList.add("bi-star-fill")
				button.firstChild.classList.remove("bi-star")
				list.push(favouriteValue)
			}
			localStorage.setItem(favouriteKey, JSON.stringify(list))
			if (mainResultsDropdown._element.classList.contains("show")) search(searchInput.value.trim())
		}
		result.firstChild.appendChild(button)
	}

	mainResultsDropdown._element.append(result)
	return result
}

function searchHeader(inner) {
	if (lastDropdownLi) {
		lastDropdownLi = document.createElement("li")
		lastDropdownLi.innerHTML = "<hr class=\"dropdown-divider\">"
		mainResultsDropdown._element.append(lastDropdownLi)
	}

	lastDropdownLi = document.createElement("li")
	lastDropdownLi.innerHTML = "<h6 class=\"dropdown-header\">" + inner + "</h6>"
	mainResultsDropdown._element.append(lastDropdownLi)
}

// function updateTempBusShape(trip) {
// 	if (trip && lastVehicleFeed) {
// 		const shape = shapes[trip.shape_id]
// 		const currentStops = stopTimes[trip.trip_id]
// 		if (tempBusShape) updateTempBusShape()

// 		const points = shape.map((shape) => [Number(shape.shape_pt_lat), Number(shape.shape_pt_lon), shape.distance])
// 		var t = 0, last = new Date(), c, time, offset

// 		tempBusStations = currentStops.map((stopTime) => {
// 			c = stops.find((stop) => stop.stop_id == stopTime.stop_id)
// 			if (c) {
// 				time = new Date()
// 				time.setHours(...stopTime.arrival_time.split(":"))
// 				// c = L.marker([c.stop_lat, c.stop_lon], { icon: busStationIcon, zIndexOffset: 1000 }).addTo(map).popup = L.popup({ autoPan: false, content: `<b style="font-size:20px">${c.stop_name}</b><br>${stopTime.arrival_time == stopTime.departure_time ? `${offset = Math.floor((time - last) / 1000) < 0 ? `Arrived/Departed: ${Math.abs(offset)} seconds ago` : `Arriving/Departing In: ${offset}`} (${time.toLocaleTimeString(undefined, {timeStyle: "short"})})` : `Arrives: ${stopTime.arrival_time}<br>Departs: ${stopTime.departure_time}`}${stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}` })
// 				c = L.marker([c.stop_lat, c.stop_lon], { icon: busStationIcon, zIndexOffset: 1000 }).addTo(map)
// 				c.bindPopup(c.popup = L.popup({ autoPan: false, content: `<b style="font-size:20px">${c.stop_name}</b><br>${stopTime.arrival_time == stopTime.departure_time ? `Arrived/Departed: (${time.toLocaleTimeString(undefined, { timeStyle: "short" })})` : `Arrives: ${stopTime.arrival_time}<br>Departs: ${stopTime.departure_time}`}${stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}` }))
// 				c.stopName = stop.stop_name
// 				c.time = time
// 				return c
// 			}
// 		})
// 		tempBusMarker = L.marker([0, 0], { zIndexOffset: 1100 }).addTo(map)
// 		tempBusShape = L.polyline(shape.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: "red" }).addTo(map)
// 		tempInterval = setInterval(() => {
// 			t = (t + 0.0001) % 1
// 			for (let point of points) {
// 				if (point[2] > t) {
// 					if (last) {
// 						c = (t - last[2]) / (point[2] - last[2])
// 						tempBusMarker.setLatLng([last[0] + (point[0] - last[0]) * c, last[1] + (point[1] - last[1]) * c])
// 						break
// 					} else tempBusMarker.setLatLng([point[0], point[1]])
// 				} else last = point
// 			}
// 		}, 10)

// 		map.once("click", () => updateTempBusShape())
// 		// tempInterval = setInterval(() => {
// 		// 	last = new Date()
// 		// 	tempBusStations.forEach((marker) => {
// 		// 		marker.setContent(`<b style="font-size:20px">${marker.stopName}</b><br>${marker.stopTime.arrival_time == marker.stopTime.departure_time ? `Arrives/Departs In: ${offset = Math.floor((marker.time - last) / 1000) < 0 ? `Arrived/Departed: ${Math.abs(offset)} seconds ago` : `Arriving/Departing In: ${offset}`} (${marker.time.toLocaleTimeString(undefined, {timeStyle: "short"})})` : `Arrives: ${marker.stopTime.arrival_time}<br>Departs: ${marker.stopTime.departure_time}`}${marker.stopTime.pickup_type == 1 ? "<br><b>Drop-off Only</b>" : ""}`)
// 		// 	})
// 		// }, 1000)
// 	} else {
// 		tempBusShape && tempBusShape.remove()
// 		tempBusMarker && tempBusMarker.remove()
// 		tempInterval && clearInterval(tempInterval)
// 		tempBusStations && tempBusStations.forEach((marker) => marker && marker.remove().popup.remove())
// 	}
// }

// function updateMarkers(vehicleFeed = lastVehicleFeed) {
// 	lastVehicleFeed = vehicleFeed
// 	if (vehicleFeed) {
// 		const routes = []//filterInput.value.split(",").map((route) => route.trim())
// 		Object.keys(entities).forEach((value) => {
// 			if (entities[value] && (!vehicleFeed.entities[value] || ((routes.length > 0 && !routes.includes(vehicleFeed.entities[value].vehicle.tripDescriptor.routeId.split("-")[0]))))) {
// 				entities[value].marker.remove()
// 				entities[value].popup.remove()
// 				entities[value] = null
// 			}
// 		})
// 		Object.keys(vehicleFeed.entities).forEach((value) => {
// 			/**
// 			 * @type {FeedEntity}
// 			 */
// 			const entity = vehicleFeed.entities[value]
// 			const vehicle = entity.vehicle
// 			var store, popup, trip, stop
// 			if (vehicle) {
// 				const route = vehicle.tripDescriptor.routeId.split("-")[0]
// 				const position = vehicle.position
// 				if (position && (routes.length == 0 || routes.includes(route))) {
// 					store = entities[value]
// 					if (store) {
// 						trip = trips.find((value) => value.trip_id == vehicle.tripDescriptor.tripId)
// 						stop = stops.find((value) => value.stop_id == vehicle.stopId)
// 						if (!trip || !stop) return
// 						store.marker.setLatLng([position.latitude, position.longitude])
// 						switch (vehicle.status) {
// 							case "Stopped":
// 								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Stopped At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 							case "Departed":
// 								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Next Stop: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 							case "Arriving":
// 								store.popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Arriving At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 						}

// 					} else {
// 						trip = trips.find((value) => value.trip_id == vehicle.tripDescriptor.tripId)
// 						stop = stops.find((value) => value.stop_id == vehicle.stopId)
// 						if (!trip || !stop) return
// 						store = {
// 							popup: popup = L.popup({ autoPan: false }).setContent(`<b style="font-size:20px">${route}</b><br>Status: ${vehicle.status}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}<br>${stop.stop_name}`),
// 							marker: L.marker([position.latitude, position.longitude], { icon: trip.direction_id == 0 ? inboundBusIcon : outbooundBusIcon, autoPanOnFocus: false }).bindPopup(popup).on("popupopen", () => updateTempBusShape(trip)).addTo(map)
// 						}
// 						switch (vehicle.status) {
// 							case "Stopped":
// 								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Stopped At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 							case "Departed":
// 								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Next Stop: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 							case "Arriving":
// 								popup.setContent(`<b style="font-size:20px">${route} - ${trip.direction_id == 0 ? "Inbound" : "Outbound"}</b><br>Arriving At: ${stop.stop_name}<br>Last Updated: ${vehicle.timestamp.toLocaleString()}`)
// 								break
// 						}
// 						entities[value] = store
// 					}
// 				}
// 			}
// 		})
// 	}
// }

function search(query) {
	if (workerReady) {
		worker.postMessage({ command: "main_search", query, location: lastPosition, favouriteRoutes: JSON.parse(localStorage.getItem("favourite_routes")), favouriteStops: JSON.parse(localStorage.getItem("favourite_stops")) }, true)
	} else {
		lastDropdownLi = null
		Array.from(mainResultsDropdown._element.children).forEach((child) => {
			if (child.tagName == "LI") child.remove()
		})

		searchHeader("Loading Translink Data...")
		mainResultsDropdown.show()
	}
}

function handleOrientation(event) {
	let heading
	if (event.absolute && event.alpha !== null) {
		searchInput.value = event.alpha // alpha is 0-360 degrees
	} else if (event.webkitCompassHeading) {
		searchInput.value = event.webkitCompassHeading // iOS Safari
	}
}

function updateFavouriteRouteFilters() {
	Array.from(favouriteRouteFiltersList.children).forEach((child) => {
		if (child.tagName == "OPTION") child.remove()
	})
	JSON.parse(localStorage.getItem("favourite_route_filters"))?.forEach((value) => {
		favouriteRouteFiltersList.innerHTML += "<option>" + value + "</option>"
	})
}

map.on("moveend", () => {
	const pos = map.getCenter()
	url.searchParams.set("pos", pos.lat + "," + pos.lng)
	url.searchParams.set("z", map.getZoom())
	history.replaceState(null, "", url)

	if (!mapDebounce) {
		mapDebounce = true
		worker.postMessage({ command: "map_position", bounds: map.getBounds() }, true)
	}
})

map.on("popupclose", (event) => {
	if (event.popup.temp) {
		event.popup.temp = null
		event.popup.remove()
	}
})

map.on("locationfound", (event) => {
	lastPosition = event.latlng
	locationCircle.setLatLng(event.latlng)
	locationCircle.setRadius(event.accuracy)
	locationCircle.addTo(map)
	locationMarker.setLatLng(event.latlng)
	locationMarker.addTo(map)
})

map.on("locationerror", (event) => createAlert("warning", `Failed to obtain current location: ${event.message}`, true))

searchInput.addEventListener("input", () => {
	search(replaceContractions(searchInput.value.trim().toLowerCase()))
})

searchInput.addEventListener("focus", () => {
	search(replaceContractions(searchInput.value.trim().toLowerCase()))
})

searchInput.addEventListener("blur", (event) => {
	if (searchInput.value.trim().length == 0 && !mainResultsDropdown._element.contains(event.relatedTarget)) mainResultsDropdown.hide()
})

searchInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault()
		searchInput.blur()
	}
})

routeFilterInput.addEventListener("input", () => {
	if (JSON.parse(localStorage.getItem("favourite_route_filters"))?.includes(routeFilterInput.value.trim())) {
		addFavouriteRouteFilterButton.firstChild.classList.remove("bi-star")
		addFavouriteRouteFilterButton.firstChild.classList.add("bi-star-fill")
	} else {
		addFavouriteRouteFilterButton.firstChild.classList.remove("bi-star-fill")
		addFavouriteRouteFilterButton.firstChild.classList.add("bi-star")
	}
})

routeFilterInput.addEventListener("keydown", (event) => {
	if (event.key === "Enter") {
		event.preventDefault()
		routeFilterInput.blur()
	}
})

addFavouriteRouteFilterButton.onclick = () => {
	const value = routeFilterInput.value.trim()
	if (value.length) {
		const list = JSON.parse(localStorage.getItem("favourite_route_filters"))
		if (list) {
			const index = list.indexOf(value)
			if (index >= 0) {
				list.splice(index, 1)
				addFavouriteRouteFilterButton.firstChild.classList.remove("bi-star-fill")
				addFavouriteRouteFilterButton.firstChild.classList.add("bi-star")
				localStorage.setItem("favourite_route_filters", JSON.stringify(list))
			} else {
				list.push(value)
				addFavouriteRouteFilterButton.firstChild.classList.remove("bi-star")
				addFavouriteRouteFilterButton.firstChild.classList.add("bi-star-fill")
				localStorage.setItem("favourite_route_filters", JSON.stringify(list))
			}

			updateFavouriteRouteFilters()
		}
	}
}

filterMapButton.parentElement.onsubmit = (event) => {
	event.preventDefault()
	worker.postMessage({
		command: "map_filters", filters: {
			routes: routeFilterInput.value.length && routeFilterInput.value.trim().split(/\s*,\s*/g)
		}
	}, true)
}

routePane.querySelector(".btn-close").onclick = (event) => {
	lastRouteId = null
	event.preventDefault()
	routePane.classList.remove("show")
	Object.values(vehiclePositionMarkers).forEach((marker) => marker.setOpacity(1))
	worker.postMessage({ command: "route_timetable" })
	if (tempBusShape) tempBusShape.remove()
}

routePane.querySelector("h1").onclick = (event) => {
	event.preventDefault()
	routePane.classList.toggle("mini")
}

locateButton.addEventListener("click", () => map.locate({ setView: true, maxZoom: 16 }))

worker.onmessage = (data) => {
	const request = data.data

	switch (request.command) {
		case "ready": {
			workerReady = true
			console.log("Worker Ready")
			worker.postMessage({ command: "map_position", bounds: map.getBounds() })
			if (mainResultsDropdown._element.classList.contains("show")) search(searchInput.value.trim())
			if (request.error) createAlert("warning", "Failed to load Real-Time Information", true)
			break
		}
		case "parsing": {
			createAlert("info", "Downloading latest GTFS data...", true)
			break
		}
		case "main_search": {
			lastDropdownLi = null
			Array.from(mainResultsDropdown._element.children).forEach((child) => {
				if (child.tagName == "LI") child.remove()
			})

			if (request.favouriteRoutes?.length) {
				searchHeader("Favourite Routes")
				request.favouriteRoutes.forEach((route) => searchResult("<i class=\"small me-2 bi " + (routeTypes[route.route_type] || "bi-question-lg") + "\"></i><p class=\"small m-0 flex-grow-1\">" + (route.route_short_name.length ? route.route_short_name + (route.route_long_name.length ? " - " + route.route_long_name : "") : route.route_long_name) + "</p>", "favourite_routes", route.route_id).addEventListener("click", () => {
					mainResultsDropdown.hide()
					const date = new Date(Date.now() - 30 * 60 * 1000)
					worker.postMessage({ command: "route_timetable", id: route.route_id, date, start: date.toTimeString().split(" ", 1)[0] }, true)
				}))
			}

			if (request.favouriteStops?.length) {
				searchHeader("Favourite Stops - Stations")

				request.favouriteStops.forEach((stop) => searchResult("<p class=\"small m-0 flex-grow-1 " + (stop.distance ? "me-2" : "") + "\">" + stop.stop_name + "</p>" + (stop.distance ? "<b class=\"small\">" + ((stop.distance < 1) ? (Math.round(stop.distance * 1000) + "m</b>") : (stop.distance.toFixed(2)) + "km</b>") : ""), "favourite_stops", stop.stop_id).addEventListener("click", () => {
					mainResultsDropdown.hide()
					L.popup([stop.stop_lat, stop.stop_lon], { content: `<b style="font-size:20px">${stop.stop_name}</b>`, autoPan: false }).openOn(map.flyTo([stop.stop_lat, stop.stop_lon], 17)).temp = true
				}))
			}

			if (request.routes?.length) {
				searchHeader("Routes")
				request.routes.forEach((route) => searchResult("<i class=\"small me-2 bi " + (routeTypes[route.route_type] || "bi-question-lg") + "\"></i><p class=\"small m-0 flex-grow-1\">" + (route.route_short_name.length ? route.route_short_name + (route.route_long_name.length ? " - " + route.route_long_name : "") : route.route_long_name) + "</p>", "favourite_routes", route.route_id).addEventListener("click", () => {
					mainResultsDropdown.hide()
					const date = new Date(Date.now() - 30 * 60 * 1000)
					worker.postMessage({ command: "route_timetable", id: route.route_id, date, start: date.toTimeString().split(" ", 1)[0] }, true)
				}))
			}

			if (request.stops?.length) {
				searchHeader("Stops - Stations")

				request.stops.forEach((stop) => searchResult("<p class=\"small m-0 flex-grow-1 " + (stop.distance ? "me-2" : "") + "\">" + stop.stop_name + "</p>" + (stop.distance ? "<b class=\"small\">" + ((stop.distance < 1) ? (Math.round(stop.distance * 1000) + "m</b>") : (stop.distance.toFixed(2)) + "km</b>") : ""), "favourite_stops", stop.stop_id).addEventListener("click", () => {
					mainResultsDropdown.hide()
					L.popup([stop.stop_lat, stop.stop_lon], { content: `<b style="font-size:20px">${stop.stop_name}</b>`, autoPan: false }).openOn(map.flyTo([stop.stop_lat, stop.stop_lon], 17)).temp = true
				}))
			}

			if (!lastDropdownLi) searchHeader("No Results Found")

			mainResultsDropdown._element.parentElement.classList.remove("loading")
			mainResultsDropdown.show()
			break
		}
		case "route_info": {
			console.log(request)
			break
		}
		case "route_timetable": {
			if (request.route) {
				var currentRouteId = request.route.route_id
				routePaneCode.innerText = request.route.route_short_name
				routePaneName.innerText = request.route.route_long_name
				routePane.style.setProperty("--route-color", "#" + request.route.route_color)
				routePane.style.setProperty("--route-text-color", "#" + request.route.route_text_color)

				function load(direction) {
					const { stops, times, shapes, trips } = direction
					const body = routePaneTimetable.tBodies[0]

					if (tempBusShape) tempBusShape = tempBusShape.remove()
					if (shapes) {
						tempBusShape = L.polyline(shapes, { color: "#" + request.route.route_color, weight: 5, interactive: false }).addTo(map)
					}

					Object.values(vehiclePositionMarkers).forEach((marker) => marker.setOpacity(marker.routeId == currentRouteId && marker.direction == currentRouteDirection ? 1 : 0))

					if (times.length) {
						routePaneTimetable.tHead.innerHTML = ""
						let row = routePaneTimetable.tHead.insertRow()
						let item
						row.innerHTML = "<th scope=\"col\" class=\"border-top border-start\">Stop</th>"
						trips.forEach((id, index) => {
							item = document.createElement("th")
							item.scope = "col"
							item.innerText = "Trip Details"
							item.onclick = () => {
								worker.postMessage({ command: "trip_info", id: id[0] }, true)
								item = ({ data }) => {
									if (data.command == "trip_info") {
										worker.removeEventListener("message", item)
										if (data.vehiclePosition?.vehicle?.position) {
											map.flyTo([data.vehiclePosition.vehicle.position.latitude, data.vehiclePosition.vehicle.position.longitude], 17)
										}
									}
								}
								worker.addEventListener("message", item)
							}

							// fetch(`https://www.data.qld.gov.au/api/action/datastore_search_sql`, {
							// 	method: 'POST',
							// 	headers: { 'content-type': 'application/json' },
							// 	body: JSON.stringify({
							// 		sql: id[1]
							// 	})
							// }).then((response) => {
							// 	if (response.ok) {
							// 		response.json().then((data) => {
							// 			data.result.records.sort((a, b) => a.stop.split(" ", 1) - b.stop.split(" ", 1)).forEach((record) => {
							// 				item = body?.rows[record.stop.split(" ", 1) - 1]?.cells[index + 1]
							// 				if (item) item.innerHTML += "<sup class=\"m-1\"><span class=\"d-inline-block p-1 bg-" + badgeColours[record.availability] + " border border-light rounded-circle\"><span class=\"visually-hidden\">" + record.availability + "</span></span></sup>"
							// 			})
							// 		})
							// 	}
							// })

							row.append(item)
						})

						body.innerHTML = ""
						times.forEach((trips, i) => {
							row = body.insertRow()
							row.innerHTML = "<td>" + stops[i][1] + "</td>"
							trips.forEach((time) => row.innerHTML += "<td>" + timetable12Hr(time[0]) + (time[2] ? "<sup class=\"\"><img src=\"./images/realtime.svg\" width=\"12\" height=\"12\">" : "") + "</td>")
						})
					}
				}

				if (request.directions[1]) {
					routePaneOutbound.classList.remove("disabled")
					if (!request.directions[0] || routePaneOutbound.classList.contains("active")) {
						routePaneOutbound.classList.add("active")
						routePaneInbound.classList.remove("active")
						currentRouteDirection = 1
						if (request.directions[1].valid) {
							load(request.directions[1])
							if (tempBusShape && lastRouteId != request.route.route_id) map.fitBounds(tempBusShape.getBounds())
						} else {
							routePaneTimetable.tHead.innerHTML = "No Trips Available"
							routePaneTimetable.tBodies[0].innerHTML = ""
							if (tempBusShape) tempBusShape.remove()
							if (request.directions[1].shapes) {
								tempBusShape = L.polyline(request.directions[1].shapes.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: "#" + request.route.route_color, weight: 5, interactive: false }).addTo(map)
								if (lastRouteId != request.route.route_id) map.fitBounds(tempBusShape.getBounds())
							}
						}
					}

					routePaneOutbound.onclick = (event) => {
						event.preventDefault()
						routePaneOutbound.classList.add("active")
						routePaneInbound.classList.remove("active")
						currentRouteDirection = 1
						if (request.directions[1].valid) {
							load(request.directions[1])
							if (tempBusShape) map.fitBounds(tempBusShape.getBounds())
						} else {
							routePaneTimetable.tHead.innerHTML = "No Trips Available"
							routePaneTimetable.tBodies[0].innerHTML = ""
							if (tempBusShape) tempBusShape.remove()
							if (request.directions[1].shapes) {
								tempBusShape = L.polyline(request.directions[1].shapes.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: "#" + request.route.route_color, weight: 5, interactive: false }).addTo(map)
								map.fitBounds(tempBusShape.getBounds())
							}
						}
					}
				} else {
					routePaneOutbound.classList.add("disabled", true)
					routePaneOutbound.classList.remove("active")
					routePaneOutbound.ariaDisabled = true

					if (!request.directions[0]) {
						if (tempBusShape) tempBusShape.remove()
						routePaneTimetable.tHead.innerHTML = "No Trips Available"
						routePaneTimetable.tBodies[0].innerHTML = ""
					}
				}

				if (request.directions[0]) {
					routePaneInbound.classList.remove("disabled")
					if (!routePaneOutbound.classList.contains("active")) {
						routePaneInbound.classList.add("active")
						routePaneOutbound.classList.remove("active")
						currentRouteDirection = 0
						if (request.directions[0].valid) {
							load(request.directions[0])
							if (tempBusShape && lastRouteId != request.route.route_id) map.fitBounds(tempBusShape.getBounds())
						}
						else {
							routePaneTimetable.tHead.innerHTML = "No Trips Available"
							routePaneTimetable.tBodies[0].innerHTML = ""
							if (tempBusShape) tempBusShape.remove()
							if (request.directions[0].shapes) {
								tempBusShape = L.polyline(request.directions[0].shapes.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: "#" + request.route.route_color, weight: 5, interactive: false }).addTo(map)
								if (lastRouteId != request.route.route_id) map.fitBounds(tempBusShape.getBounds())
							}
						}
					}

					routePaneInbound.onclick = (event) => {
						event.preventDefault()
						routePaneInbound.classList.add("active")
						routePaneOutbound.classList.remove("active")
						currentRouteDirection = 0
						if (request.directions[0].valid) {
							load(request.directions[0])
							if (tempBusShape) map.fitBounds(tempBusShape.getBounds())
						} else {
							routePaneTimetable.tHead.innerHTML = "No Trips Available"
							routePaneTimetable.tBodies[0].innerHTML = ""
							if (tempBusShape) tempBusShape.remove()
							if (request.directions[0].shapes) {
								tempBusShape = L.polyline(request.directions[0].shapes.map((shape) => [shape.shape_pt_lat, shape.shape_pt_lon]), { color: "#" + request.route.route_color, weight: 5, interactive: false }).addTo(map)
								map.fitBounds(tempBusShape.getBounds())
							}
						}
					}
				} else {
					routePaneInbound.classList.add("disabled", true)
					routePaneInbound.classList.remove("active")
					routePaneInbound.ariaDisabled = true
				}

				routePane.classList.add("show")
				lastRouteId = request.route.route_id
			}

			break
		}
		case "vehicle_positions": {
			const vehicles = request.vehicles
			let marker

			Object.keys(vehiclePositionMarkers).forEach((key) => {
				if (!vehicles.find((entity) => entity.id == key)) {
					vehiclePositionMarkers[key].remove()
					delete vehiclePositionMarkers[key]
				}
			})

			vehicles.forEach((entity) => {
				marker = vehiclePositionMarkers[entity.id]
				if (marker) marker.setRT(entity)
				else vehiclePositionMarkers[entity.id] = new BusMarker().addTo(map).setRT(entity)

				// if (marker) {
				// 	marker.setLatLng([entity.vehicle.position.latitude, entity.vehicle.position.longitude]).setIcon(entity.vehicle.direction == 1 ? outbooundBusIcon : inboundBusIcon).routeId = entity.vehicle.tripDescriptor.routeId
				// 	marker.tripId = entity.vehicle.tripDescriptor.tripId
				// 	marker.direction = entity.vehicle.direction
				// 	if (lastRouteId) marker.setOpacity(entity.vehicle.tripDescriptor.routeId == lastRouteId && entity.vehicle.direction == currentRouteDirection ? 1 : 0)
				// } else {
				// 	marker = L.marker([entity.vehicle.position.latitude, entity.vehicle.position.longitude], { icon: entity.vehicle.direction == 1 ? outbooundBusIcon : inboundBusIcon, autoPanOnFocus: false }).addTo(map)
				// 	marker.routeId = entity.vehicle.tripDescriptor.routeId
				// 	marker.tripId = entity.vehicle.tripDescriptor.tripId
				// 	marker.direction = entity.vehicle.direction
				// 	marker.tooltip = marker.bindTooltip(L.tooltip({ content: "my tooltip text", direction: "bottom", interactive: false, permanent: true }))
				// 	if (lastRouteId) marker.setOpacity(marker.routeId == lastRouteId && marker.direction == currentRouteDirection ? 1 : 0)
				// 	vehiclePositionMarkers[entity.id] = marker
				// }
			})

			mapDebounce = false
			break
		}
	}

	if (request.tick) tickLoading(-1)
}
updateFavouriteRouteFilters()
let mediaTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)')
if (mediaTheme) {
	let html = document.querySelector("html")
	if (mediaTheme.matches) html.setAttribute("data-bs-theme", "dark")
	else html.setAttribute("data-bs-theme", "light")

	mediaTheme.onchange = () => {
		if (mediaTheme.matches) html.setAttribute("data-bs-theme", "dark")
		else html.setAttribute("data-bs-theme", "light")
	}
}

if (typeof NDEFReader != "undefined") {
	document.querySelector("ul.foot-navbar").classList.remove("d-none")

	let ndefReader = new NDEFReader()
	document.getElementById("scan_nfc").addEventListener("click", () => {
		ndefReader?.scan().then(() => {
			createAlert("info", "Hold your device to the NFC tag.", true)
			ndefReader.onreadingerror = () => createAlert("warning", "Failed to read NFC Tag, please try again.", true)
			ndefReader.onreading = (event) => {
				const record = event.message.records[0]
				alert(event.message.serialNumber)
				if (record?.recordType == "url") {
					fetch("https://trans-info.au/location/translink/?tagid=" + (new TextDecoder(record.encoding || "utf-8")).decode(record.data))
						.then(async (response) => response.ok ? worker.postMessage({ command: "stop_timetable", id: (await response.text()).match("https://translink.com.au/stop/(.+)/gtfs/")[1] }) : createAlert("warning", "Failed to fetch NFC Tag data, please try again.", true))
						.catch(() => createAlert("warning", "Failed to fetch NFC Tag data, please try again.", true))
				} else createAlert("danger", "Not a valid NFC Tag.", true)
			}
		}).catch((err) => err.name == "NotAllowedError" && createAlert("error", "NFC Scanning Permission was denied.", true))
	})
}

let initialPosition = url.searchParams.get("pos")
if (initialPosition && (initialPosition = initialPosition.split(",")).length == 2) {
	map.setView(initialPosition.map(Number), Number(url.searchParams.get("z")) || 16, { animate: false })
	navigator.permissions.query({ name: "geolocation" }).then((status) => {
		if (status.state == "granted") map.locate({ setView: false, maxZoom: 16 })
		else status.onchange = () => { if (status.state == "granted") map.locate({ setView: false, maxZoom: 16 }) }
	})
} else {
	navigator.permissions.query({ name: "geolocation" }).then((status) => {
		if (status.state == "granted") map.locate({ setView: true, maxZoom: 16 })
		else status.onchange = () => { if (status.state == "granted") map.locate({ setView: true, maxZoom: 16 }) }
	})
}

mapDebounce = true

// if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
// 	// iOS 13+ requires permission
// 	DeviceOrientationEvent.requestPermission()
// 		.then(permissionState => {
// 			if (permissionState === "granted") {
// 				window.addEventListener("deviceorientation", handleOrientation, true)
// 			} else {
// 				alert("Permission denied for compass.")
// 			}
// 		})
// 		.catch(console.error)
// } else {
// 	// Android or older iOS
// 	window.addEventListener("deviceorientationabsolute", handleOrientation, true)
// 	window.addEventListener("deviceorientation", handleOrientation, true)
// }