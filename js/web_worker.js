const pkHeader = 0x04034b50
const rad = Math.PI / 180

importScripts("proto.js")
const gtfs = {}
const proxy = "https://api.codetabs.com/v1/proxy/?quest=" //.substring(0, 0)
const preloadedFeeds = [getFeed(proxy + "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus"), getFeed(proxy + "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus")/*, getFeed(proxy + "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/alerts")*/]
const requiredFiles = ["agency.txt", "calendar.txt", "calendar_dates.txt", "feed_info.txt", "routes.txt", "shapes.txt", "stops.txt", "stop_times.txt", "trips.txt"]
const daysLower = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
const daysTitle = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const encoder = new TextEncoder()
const btoc = String.fromCharCode

var opfsRoot
var fileHandle
var syncAccessHandle

const tripUpdatesChanged = new Event("tripUpdatesChanged")
var timetableSignal

var lastTripUpdates, lastVehiclePositions, lastAlerts, lastMapBounds, lastFilters = []

function stripQuotes(buffer, start, end) {
	return decoder.decode(buffer[start] == 0x22 ? buffer.subarray(start + 1, end - 1) : buffer.subarray(start, end))
}

function getFiles(url, callback) {
	return new Promise((resolve, reject) => {
		fetch(url, { cache: "force-cache" }).then(async res => {
			const reader = res.body.getReader()
			const promises = []
			var currentHeader = pkHeader, index, buffer, headerSuccess, offsetSize, storeShift, propertyIndex, decompressionType, compressedSize, uncompressedSize, nameSize, commentSize, name, needed, fileHandle, accessHandle, decompressor, writable, result

			while (true) {
				result = await reader.read()

				if (result.done) {
					reader.releaseLock()
					Promise.all(promises).then(resolve).catch(reject)
				} else {
					buffer = result.value
					index = 0

					while (index < buffer.length) {
						if (!headerSuccess) {
							while (currentHeader > 0 && index < buffer.length) {
								if (buffer[index++] == (currentHeader & 0xff)) {
									currentHeader >>= 8
								} else {
									reader.cancel()
									reader.releaseLock()
									return Promise.all(promises).then(resolve).catch(reject)
								}
							}

							if (currentHeader == 0) {
								headerSuccess = true
								propertyIndex = 0
								offsetSize = 4
							}
						}

						if (headerSuccess) {
							switch (propertyIndex) {
								case 0:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; index++ }
									if (offsetSize == 0) {
										propertyIndex++
										decompressionType = 0
										offsetSize = 2
										storeShift = -8
									}
									break
								case 1:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; decompressionType += buffer[index++] << (storeShift += 8) }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = 8
									}
									break
								case 2:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; index++ }
									if (offsetSize == 0) {
										propertyIndex++
										compressedSize = 0
										offsetSize = 4
										storeShift = -8
									}
									break
								case 3:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; compressedSize += buffer[index++] << (storeShift += 8) }
									if (offsetSize == 0) {
										propertyIndex++
										uncompressedSize = 0
										offsetSize = 4
										storeShift = -8
									}
									break
								case 4:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; uncompressedSize += buffer[index++] << (storeShift += 8) }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = 2
										storeShift = -8
										nameSize = 0
									}
									break
								case 5:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; nameSize += buffer[index++] << (storeShift += 8) }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = 2
										commentSize = 0
										storeShift = -8
									}
									break
								case 6:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; commentSize += buffer[index++] << (storeShift += 8) }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = nameSize
										name = ""
									}
									break
								case 7:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; name += btoc(buffer[index++]) }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = commentSize
										if (needed = requiredFiles.includes(name)) {
											fileHandle = await opfsRoot.getFileHandle(name, { create: true })
											accessHandle = await fileHandle.createSyncAccessHandle()
										}
									}
									break
								case 8:
									while (offsetSize > 0 && index < buffer.length) { offsetSize--; index++ }
									if (offsetSize == 0) {
										propertyIndex++
										offsetSize = compressedSize
										if (needed) {
											decompressor = new DecompressionStream("deflate-raw")
											writable = decompressor.writable.getWriter()
										}
									}
									break
								case 9:
									if (offsetSize > buffer.length - index) {
										if (needed) writable.write(buffer.slice(index, buffer.length))
										offsetSize -= buffer.length - index
										index = buffer.length
									} else {
										if (needed) {
											writable.write(buffer.slice(index, index += offsetSize))
											writable.close()
											writable.releaseLock()
											await callback(name, decompressor.readable, accessHandle, uncompressedSize)
										} else index += offsetSize

										headerSuccess = false
										currentHeader = pkHeader
										offsetSize = 0
									}
									break
							}
						}
					}
				}
			}
		}).catch(reject)
	})
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

async function parseFile(name, reader, handle, size) {
	const header = []
	const group = []
	var body = [0]
	var a = []
	var bIndex = 0
	var rIndex = 0
	var pIndex = -1
	var aIndex = -1
	var bodyIndex = -1
	var proxyBuffer
	var size, hLength, byte, invalid, item, temp1, temp2, temp3

	name = name.slice(0, -4)
	console.log(`Parsing CSV ${name}...`)
	console.time(`Parsed CSV ${name}`)

	if (reader instanceof Uint8Array) {
		proxyBuffer = reader
		size = reader.length
		bIndex = 0
		temp1 = -1
		// for (; bIndex < size; ++bIndex) { if (reader[bIndex] == 0x0A) ++temp1 }
		// bIndex = 0
		// body = new Array(temp1)

		for (; !hLength && bIndex < size; ++bIndex) {
			byte = reader[bIndex]
			if (invalid) {
				if (byte == 0x22) invalid = false
				else group.push(byte)
			} else {
				if (byte == 0x22) invalid = true
				else if (byte == 0x2C) { header.push(btoc(...group)); group.length = 0 }
				else if (byte == 0x0A) { header.push(btoc(...group)); group.length = 0; hLength = header.length + 1; rIndex = bIndex + 1 }
				else if (byte != 0x0D) group.push(byte)
			}
		}

		// a = new Array(temp1 * hLength)

		for (; bIndex < size; ++bIndex) {
			byte = reader[bIndex]
			if (invalid) {
				if (byte == 0x22) invalid = false
			} else {
				if (byte == 0x22) invalid = true
				else if (byte == 0x2C) { a[++aIndex] = rIndex; rIndex = bIndex + 1 }
				else if (byte == 0x0A) { a[++aIndex] = rIndex; a[++aIndex] = bIndex; rIndex = bIndex + 1; pIndex = -1; body[++bodyIndex] = aIndex + 1 }
			}
		}
	} else {
		var hSize = 0
		proxyBuffer = new Uint8Array(size)

		reader = reader.getReader()
		while (true) {
			const result = await reader.read()

			if (result.done) break
			else {
				const buffer = result.value
				size = buffer.length
				bIndex = 0

				for (; !hLength && bIndex < size; ++bIndex) {
					byte = buffer[bIndex]
					if (invalid) {
						if (byte == 0x22) invalid = false
						else group.push(byte)
					} else {
						if (byte == 0x22) invalid = true
						else if (byte == 0x2C) { header.push(btoc(...group)); group.length = 0 }
						else if (byte == 0x0A) { header.push(btoc(...group)); group.length = 0; hLength = header.length + 1; rIndex = hSize + bIndex + 1 }
						else if (byte != 0x0D) group.push(byte)
					}
				}

				for (; bIndex < size; ++bIndex) {
					byte = reader[bIndex]
					if (invalid) {
						if (byte == 0x22) invalid = false
					} else {
						if (byte == 0x22) invalid = true
						else if (byte == 0x2C) { a[++aIndex] = rIndex; rIndex = hSize + bIndex + 1 }
						else if (byte == 0x0A) { a[++aIndex] = rIndex; a[++aIndex] = hSize + bIndex; rIndex = hSize + bIndex + 1; pIndex = -1; body[++bodyIndex] = aIndex + 1 }
					}
				}

				handle.write(buffer, { at: hSize })
				proxyBuffer.set(buffer, hSize)
				hSize += size
			}
		}

		reader = reader.releaseLock()
	}

	// if (byte == 0x2C) { item[header[pIndex + 1]] = ""; body.push(item) }
	// else if (byte == 0x0D) body.push(item)
	// else if (byte != 0x0A) { item[pIndex + 1] = btoc(...group); body.push(item) }
	console.timeEnd(`Parsed CSV ${name}`)

	var final
	const listFind = function (property, value, start = 0) {
		const kIndex = header.indexOf(property)
		if (kIndex == -1) return
		let i, j, l, index
		var size = this.length
		value = encoder.encode(value)
		k = value.length
		for (let bi = start; bi != size; bi++) {
			index = this[bi];
			j = -1
			i = a[index + kIndex]
			l = a[index + kIndex + 1] - 1
			if (l - i != k) continue
			for (; i != l; ++i) if (proxyBuffer[i] != value[++j]) { l = null; break }
			if (i == l) return header.reduce((object, property) => (object[property] = stripQuotes(proxyBuffer, a[index], a[++index] - 1), object), {})
		}
	}

	const listIndexOf = function (property, value, start = 0) {
		const kIndex = header.indexOf(property)
		if (kIndex == -1) return
		let i, j, l, index
		var size = this.length
		value = encoder.encode(value)
		k = value.length
		for (let bi = start; bi != size; ++bi) {
			index = this[bi];
			i = a[index += kIndex]
			l = a[index + 1] - 1
			if (l - i != k) continue
			j = -1
			for (; i != l; ++i) if (proxyBuffer[i] != value[++j]) { l = null; break }
			if (i == l) return bi
		}
	}

	const listFilter = function (property, value, start = 0, stop) {
		const kIndex = header.indexOf(property)
		const result = []
		if (kIndex == -1) return
		let i, j, l, index
		var size = this.length
		value = encoder.encode(value)
		k = value.length
		for (let bi = start; bi != size; bi++) {
			index = this[bi];
			j = -1
			i = a[index + kIndex]
			l = a[index + kIndex + 1] - 1
			if (l - i != k) if (stop && result.length) break; else continue
			for (; i != l; ++i) if (proxyBuffer[i] != value[++j]) { l = null; break }
			if (i == l) result.push(index); else if (stop && result.length) break
		}
		return new Proxy(result, proxy)
	}

	const listGet = function (index1, index2) {
		return stripQuotes(proxyBuffer, a[index2 += this[index1]], a[index2 + 1] - 1)
	}

	const proxy = {
		get(list, property) {
			if (typeof (property) == "string") {
				if (property == "listFind") return listFind.bind(list)
				if (property == "listIndexOf") return listIndexOf.bind(list)
				if (property == "listFilter") return listFilter.bind(list)
				if (property == "listGet") return listGet.bind(list)
				var index = parseInt(property)
				if (index == index) return (index = list[index], header.reduce((object, property) => (object[property] = stripQuotes(proxyBuffer, a[index], a[++index] - 1), object), {}))
			}
			return list[property]
		}
	}

	let kIndex
	switch (name) {
		case "shapes":
			kIndex = header.indexOf("shape_id")
			body.pop()
			final = new Proxy({}, {
				get(_, value) {
					if (value == "listGet") return listGet.bind(list)
					const result = []
					if (kIndex == -1) return
					let i, j, l, index
					var size = body.length
					value = encoder.encode(value)
					k = value.length
					for (let bi = 0; bi != size; bi++) {
						index = body[bi];
						j = -1
						i = a[index + kIndex]
						l = a[index + kIndex + 1] - 1
						if (l - i != k) continue
						for (; i != l; ++i) if (proxyBuffer[i] != value[++j]) { l = null; break }
						if (i == l) result.push(index)
					}
					return new Proxy(result, proxy)
				}
			})

			break
		// 	final = {}
		// 	temp1 = 0
		// 	temp3 = body[0].shape_id

		// 	let shape
		// 	while (shape = body.pop()) {
		// 		// if (shape.shape_id != temp3) {
		// 		// 	temp1 = 1 / temp1
		// 		// 	temp2 = 0
		// 		// 	result[temp3].forEach((shape) => temp2 = (shape.distance = shape.distance * temp1 + temp2))
		// 		// 	temp1 = 0
		// 		// 	temp2 = null
		// 		// }
		// 		// if (temp2) temp1 += (shape.distance = distance(temp2.shape_pt_lat, temp2.shape_pt_lon, shape.shape_pt_lat, shape.shape_pt_lon))
		// 		// else shape.distance = 0
		// 		temp3 = shape.shape_id
		// 		temp2 = result[temp3]
		// 		if (temp2) temp2.push(shape)
		// 		else result[temp3] = [shape]
		// 		temp2 = shape
		// 	}

		// 	break
		default:
			final = new Proxy(body, proxy)
	}

	gtfs[name] = final
}

function isServiceActive(id, date) {
	const service = gtfs.calendar.listFind("service_id", id)
	if (!service) return
	const day = daysLower[date.getDay()]
	date = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`
	if (service[day] == "1" && service.start_date <= date && service.end_date >= date) return !(gtfs.calendar_dates.listFilter("service_id", id).listFind("date", date)?.exception_type == "2")
	else return gtfs.calendar_dates.listFilter("service_id", id).listFind("date", date)?.exception_type == "1"
}

function availability12Hr(t) {
	var h = Number(t.slice(0, 2))
	var m = Math.round(t.slice(3, 5) / 15) * 15
	if (m >= 60) m = 0, h++
	return ((h %= 24) > 12 ? (h - 12) : h == 0 ? 12 : h) + ":" + m.toString().padStart(2, "0") + (h >= 12 ? " PM" : " AM")
}

function inBounds(bounds, lat, lon) {
	return lat >= bounds._southWest.lat && lon >= bounds._southWest.lng && lat <= bounds._northEast.lat && lon <= bounds._northEast.lng
}

function filterArrayIncludes(array, includes) {
	return !array?.length || array.includes(includes)
}

function postVehiclePositions(tick) {
	if (lastVehiclePositions && lastMapBounds) {
		const routes = lastFilters?.routes?.length && []
		const vehicleFind = (id, entity) => entity.tripUpdate.vehicle?.id == id
		const stopTimeUpdateFind = (id, stopTimeUpdate) => stopTimeUpdate.stopSequence <= id
		const vehicles = []
		let delay
		if (routes) {
			lastFilters.routes.forEach((value) => gtfs.routes.listFilter("route_short_name", value).forEach((route) => routes.push(route.route_id)))
			lastVehiclePositions.forEach(({ vehicle }) => {
				if (vehicle?.position && inBounds(lastMapBounds, vehicle.position.latitude, vehicle.position.longitude) && routes.includes(vehicle.tripDescriptor.routeId)) {
					delay = (vehicle.tripUpdate || (vehicle.tripUpdate = lastTripUpdates.find(vehicleFind.bind(null, vehicle.vehicle.id))))?.tripUpdate?.stopTimeUpdates?.findLast(stopTimeUpdateFind.bind(null, vehicle.currentStopSequence))
					if (delay) {
						if (delay.departure?.delay != undefined) {
							if (delay.arrival?.delay != undefined) {
								if (Math.abs(delay.arrival.delay) < Math.abs(delay.departure.delay)) delay = delay.arrival.delay
								else delay = delay.departure.delay
							} else delay = delay?.departure?.delay
						} else if (delay.arrival?.delay != undefined) delay = delay.arrival.delay
					}
					vehicles.push({
						routeId: vehicle.tripDescriptor.routeId,
						direction: (vehicle.trip || (vehicle.trip = gtfs.trips.listFind("trip_id", vehicle.tripDescriptor.tripId)))?.direction_id || 0,
						route: (vehicle.route || (vehicle.route = gtfs.routes.listFind("route_id", vehicle.tripDescriptor.routeId)))?.route_short_name || vehicle.tripDescriptor.routeId,
						position: [vehicle.position.latitude, vehicle.position.longitude],
						delay: delay != undefined && (delay = Math.round(delay / 60)) >= 0 ? `+${delay}` : delay,
						id: vehicle.vehicle.id
					})
				}
			})
		} else {
			lastVehiclePositions.forEach(({ vehicle }) => {
				if (vehicle?.position && inBounds(lastMapBounds, vehicle.position.latitude, vehicle.position.longitude)) {
					delay = (vehicle.tripUpdate || (vehicle.tripUpdate = lastTripUpdates.find(vehicleFind.bind(null, vehicle.vehicle.id))))?.tripUpdate?.stopTimeUpdates?.findLast(stopTimeUpdateFind.bind(null, vehicle.currentStopSequence))
					if (delay) {
						if (delay.departure?.delay != undefined) {
							if (delay.arrival?.delay != undefined) {
								if (Math.abs(delay.arrival.delay) < Math.abs(delay.departure.delay)) delay = delay.arrival.delay
								else delay = delay.departure.delay
							} else delay = delay?.departure?.delay
						} else if (delay.arrival?.delay != undefined) delay = delay.arrival.delay
					}
					vehicles.push({
						routeId: vehicle.tripDescriptor.routeId,
						direction: (vehicle.trip || (vehicle.trip = gtfs.trips.listFind("trip_id", vehicle.tripDescriptor.tripId)))?.direction_id || 0,
						route: (vehicle.route || (vehicle.route = gtfs.routes.listFind("route_id", vehicle.tripDescriptor.routeId)))?.route_short_name || vehicle.tripDescriptor.routeId,
						position: [vehicle.position.latitude, vehicle.position.longitude],
						delay: delay != undefined && (delay = Math.round(delay / 60)) >= 0 ? `+${delay}` : delay,
						id: vehicle.vehicle.id
					})
				}
			})
		}
		postMessage({ command: "vehicle_positions", tick, vehicles })
	} else if (tick) postMessage({ command: "ack", tick })
}

function ready(error) {
	if (error)
		postMessage({ command: "ready", error, tick: true })
	else {
		postMessage({ command: "ready", tick: true })
		Promise.all(preloadedFeeds).then((feeds) => {
			lastTripUpdates = feeds[0].entities
			lastVehiclePositions = feeds[1].entities
			// lastAlerts = feeds[2].entities
			postVehiclePositions()
		}).catch((error) => {
			postMessage({ command: "ready", error, tick: true })
		})
		setInterval(() => {
			Promise.all([getFeed(proxy + "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/TripUpdates/Bus"), getFeed(proxy + "https://gtfsrt.api.translink.com.au/api/realtime/SEQ/VehiclePositions/Bus")]).then((feeds) => {
				lastTripUpdates = feeds[0].entities
				lastVehiclePositions = feeds[1].entities
				self.dispatchEvent(tripUpdatesChanged)
				postVehiclePositions()
			}).catch(() => { })
		}, 15000)
	}
}

console.log("Worker Initializing...")

navigator.storage.getDirectory().then(async (dir) => {
	console.time("Test")
	opfsRoot = dir

	for await (const key of dir.keys()) {
		const file = await dir.getFileHandle(key)
		const handle = await file.createSyncAccessHandle({ mode: "read-only" })
		const buffer = new Uint8Array(handle.getSize())
		handle.read(buffer)
		handle.close()
		await parseFile(key, buffer)

		const index = requiredFiles.indexOf(key)
		if (index > -1) requiredFiles.splice(index, 1)
	}

	if (requiredFiles.length) {
		getFiles("../SEQ_GTFS.zip", parseFile).then(() => {
			console.timeEnd("Test")
			ready()
		}).catch((error) => {
			console.error(error)
			ready(error)
		})
	} else {
		console.timeEnd("Test")
		ready()
	}
})

self.onmessage = (data) => {
	const request = data.data

	switch (request.command) {
		case "main_search": {
			const stops = []
			const routes_short = []
			const routes_long = []
			const location = request.location
			const query = request.query

			if (query.length) {
				for (let route of gtfs.routes) {
					if (route.route_short_name.toLowerCase().includes(query)) if (routes_short.push(route) > 25) break
					if (route.route_long_name.toLowerCase().includes(query)) if (!routes_short.includes(route) && routes_long.push(route) > 25) break
				}
			}

			if (location) {
				for (let stop of gtfs.stops) {
					if (replaceContractions(stop.stop_name.toLowerCase()).includes(query)) {
						stop.distance = distance(stop.stop_lat, stop.stop_lon, location.lat, location.lng) * 12742
						stops.push(stop)
					}
				}

				stops.sort((a, b) => a.distance - b.distance).splice(25)
			} else {
				for (let stop of gtfs.stops) {
					if (replaceContractions(stop.stop_name.toLowerCase()).includes(query)) {
						delete stop.distance
						if (stops.push(stop) > 25) break
					}
				}
			}

			self.postMessage({
				command: "main_search",
				stops, routes: routes_short.concat(routes_long),
				favouriteRoutes: request.favouriteRoutes?.map((id) => gtfs.routes.listFind("route_id", id))?.filter((route) => route.route_short_name.toLowerCase().includes(query) || route.route_long_name.toLowerCase().includes(query)) || [],
				favouriteStops: location ? request.favouriteStops?.map((id) => gtfs.stops.listFind("stop_id", id))?.filter((stop) => replaceContractions(stop.stop_name.toLowerCase()).includes(query) && (stop.distance = distance(stop.stop_lat, stop.stop_lon, location.lat, location.lng) * 12742, 1))?.sort((a, b) => a.distance - b.distance) || []
					: request.favouriteStops?.map((id) => gtfs.stops.listFind("stop_id", id))?.filter((stop) => replaceContractions(stop.stop_name.toLowerCase()).includes(query)) || [],
				tick: request.tick
			})
			break
		}
		case "route_info": {
			const route = gtfs.routes.listFind("route_id", request.id)
			if (!route) return self.postMessage({ command: "route_info", tick: request.tick })

			self.postMessage({ command: "route_info", route, tick: request.tick })
			break
		}
		case "route_timetable": {
			if (timetableSignal) timetableSignal = timetableSignal.abort()
			if (!request.id) return

			const directions = []
			const routeID = request.id
			const route = gtfs.routes.listFind("route_id", routeID)
			if (!route) return self.postMessage({ command: "route_timetable", directions: [], tick: request.tick })

			const start = request.start || "00:00:00"
			const end = request.end || "24:59:59"
			const limit = request.limit || 4
			var date = request.date || new Date()

			let stop, dir, i, j
			console.time("route")
			for (let trip of gtfs.trips.listFilter("route_id", routeID)) {
				dir = trip.direction_id
				if (!directions[dir]) {
					directions[dir] = []
					directions[dir].shape = trip.shape_id
				}

				i = isServiceActive(trip.service_id, date) && gtfs.stop_times.listIndexOf("trip_id", trip.trip_id)
				if (i && (stop = gtfs.stop_times[i]) && stop.arrival_time >= start && stop.departure_time <= end) {
					j = directions[dir].findIndex((stops) => stops[0].arrival_time > stop.arrival_time)
					if (j == -1) j = directions[dir].length
					if (j < limit) {
						stop = gtfs.stop_times.listFilter("trip_id", trip.trip_id, i, true)
						directions[dir].splice(j, 0, stop)
						if (!directions[dir].stops) directions[dir].stops = stop
					}

				}
			}
			console.timeEnd("route")

			function update(tick) {
				let trips, times, rt, delay, sti, stops, shapes, tempShapes, query
				let finalDirections = []
				date = new Date()

				for (let direction in directions) {
					trips = directions[direction].sort((a, b) => {
						if (a[0].arrival_time > b[0].arrival_time) return 1
						else if (a[0].arrival_time < b[0].arrival_time) return -1
						else return 0
					}).slice(0, limit)
					if (trips.length && trips[0].length) {
						stops = directions[direction].stops.map((stop) => [stop.stop_id, gtfs.stops.listFind("stop_id", stop.stop_id)?.stop_name])
						times = Array.from({ length: stops.length }, () => [])

						// if (direction == 0) {
						// 	query = `SELECT stop, availability FROM "2c90611f-9631-4070-9bb7-7138df89bff7" WHERE route = '${route.route_short_name}' AND direction = '${direction == 0 ? "Inbound" : "Outbound"}' AND day_type = '${daysTitle[date.getDay()]}' AND (`
						// 	trips[0].forEach((stop, i) => {
						// 		query += `(stop_quarter_hour = '${availability12Hr(stop.arrival_time)}' AND stop LIKE '${i + 1} %')${i < trips[0].length - 1 ? " OR " : ""}`
						// 	})

						// 	fetch(`https://www.data.qld.gov.au/api/action/datastore_search_sql`, {
						// 		method: 'POST',
						// 		headers: { 'content-type': 'application/json' },
						// 		body: JSON.stringify({
						// 			sql: query + ") LIMIT " + trips[0].length
						// 		})
						// 	}).then((response) => {
						// 		if (response.ok) {
						// 			response.json().then((data) => {
						// 				data.result.records.sort((a, b) => a.stop.split(" ", 1) - b.stop.split(" ", 1)).forEach((record) => console.log(record.stop, record.availability))
						// 			})
						// 		}
						// 	})
						// }

						trips.forEach((trip) => {
							rt = lastTripUpdates?.find(({ tripUpdate }) => {
								return tripUpdate.trip && (tripUpdate.trip.routeId == undefined || tripUpdate.trip.routeId == routeID)
									&& (tripUpdate.trip.tripId == undefined || tripUpdate.trip.tripId == trip[0].trip_id)
									&& (tripUpdate.trip.startTime == undefined || tripUpdate.trip.startTime == trip[0].arrival_time || tripUpdate.trip.startTime == trip[0].departure_time)
							})?.tripUpdate?.stopTimeUpdates

							if (rt) {
								delay = 0, sti = 0
								trip.forEach((stop, i) => {
									while (sti < rt.length && rt[sti].stopSequence < stop.stop_sequence) sti++
									if (rt[sti]?.stopSequence == stop.stop_sequence && rt[sti].arrival?.delay && rt[sti].arrival?.delay != 1) delay = rt[sti].arrival.delay
									if (delay) {
										date.setHours(stop.arrival_time.substring(0, 2), stop.arrival_time.substring(3, 5), Number(stop.arrival_time.substring(6, 8)) + delay)
										times[i]?.push([date.toTimeString().substring(0, 8), stop.departure_time, true])
									} else times[i]?.push([stop.arrival_time, stop.departure_time])
								})
							} else trip.forEach((stop, i) => times[i]?.push([stop.arrival_time, stop.departure_time]))
						})
						tempShapes = gtfs.shapes[directions[direction].shape]
						shapes = new Array(tempShapes.length)
						for (let index = 0; index < tempShapes.length; ++index) {
							shapes[index] = [tempShapes.listGet(index, 1), tempShapes.listGet(index, 2)]
						}
						finalDirections[direction] = {
							stops,
							times,
							shapes,
							trips: trips.map((trip) => [trip[0].trip_id, trip.length && trip.reduce((acc, stop, i) => acc + `(stop_quarter_hour = '${availability12Hr(stop.arrival_time)}' AND stop LIKE '${i + 1} %')${i < trip.length - 1 ? " OR " : ""}`, `SELECT stop, availability FROM "2c90611f-9631-4070-9bb7-7138df89bff7" WHERE route = '${route.route_short_name}' AND direction = '${direction == 0 ? "Inbound" : "Outbound"}' AND day_type = '${daysTitle[date.getDay()]}' AND (`) + ") LIMIT " + trip.length]),
							valid: true
						}
					} else if (directions[direction].stops) {
						tempShapes = gtfs.shapes[directions[direction].shape]
						shapes = new Array(tempShapes.length)
						for (let index = 0; index < tempShapes.length; ++index) {
							shapes[index] = [tempShapes.listGet(index, 1), tempShapes.listGet(index, 2)]
						}
						finalDirections[direction] = {
							stops: directions[direction].stops.map((stop) => [stop.stop_id, gtfs.stops.listFind("stop_id", stop.stop_id)?.stop_name]),
							shapes
						}
					}
				}

				self.postMessage({ command: "route_timetable", directions: finalDirections, route, tick })
			}

			timetableSignal = new AbortController()
			self.addEventListener("tripUpdatesChanged", update.bind(null, false), { signal: timetableSignal.signal })
			update(request.tick)
			break
		}
		case "trip_info": {
			const trip = gtfs.trips.listFind("trip_id", request.id)
			if (!trip) return self.postMessage({ command: "trip_info" })

			self.postMessage({ command: "trip_info", trip, tripUpdate: lastTripUpdates?.find((({ tripUpdate }) => tripUpdate.trip.tripId == request.id)), vehiclePosition: lastVehiclePositions?.find((({ vehicle }) => vehicle.tripDescriptor.tripId == request.id)), tick: request.tick })
			break
		}
		case "trip_timetable": {
			const tripId = request.id
			const trip = gtfs.trips.listFind("trip_id", tripId)
			if (!trip) return self.postMessage({ command: "trip_timetable", tick: request.tick })

			function update(tick) {
				const tripUpdate = lastTripUpdates?.find((({ tripUpdate }) => tripUpdate.trip.tripId == tripId))
			}

			timetableSignal = new AbortController()
			self.addEventListener("tripUpdatesChanged", update.bind(null, false), { signal: timetableSignal.signal })
			update(request.tick)
			break
		}
		case "map_position": {
			lastMapBounds = request.bounds
			postVehiclePositions(request.tick)
			break
		}
		case "map_filters": {
			lastFilters = request.filters
			postVehiclePositions(request.tick)
			break
		}
		default: postMessage({ command: "ack", tick: request.tick })
	}
}