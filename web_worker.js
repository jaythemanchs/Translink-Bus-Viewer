const openRequest = indexedDB.open("gtfsDB")
const pkHeader = 0x04034b50
const rad = Math.PI / 180

function getFiles(url, callback) {
	return new Promise((resolve, reject) => {
		fetch(url, { cache: "force-cache" }).then(async res => {
			const reader = res.body.getReader()
			var currentHeader = pkHeader, headerSuccess, offsetSize, storeShift, propertyIndex, decompressionType, compressedSize, nameSize, commentSize, name, decompressor, writable, result

			while (true) {
				result = await reader.read()
				var index = 0
				const buffer = result.value

				while (index < buffer.length) {
					if (!headerSuccess) {
						while (currentHeader > 0 && index < buffer.length) {
							if (buffer[index++] == (currentHeader & 0xff)) {
								currentHeader >>= 8
							} else return resolve()
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
							case 0:
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
									offsetSize = 4
								}
								break
							case 4:
								while (offsetSize > 0 && index < buffer.length) { offsetSize--; index++ }
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
								while (offsetSize > 0 && index < buffer.length) { offsetSize--; name += String.fromCharCode(buffer[index++]) }
								if (offsetSize == 0) {
									propertyIndex++
									offsetSize = commentSize
								}
								break
							case 8:
								while (offsetSize > 0 && index < buffer.length) { offsetSize--; index++ }
								if (offsetSize == 0) {
									propertyIndex++
									offsetSize = compressedSize
									decompressor = new DecompressionStream("deflate-raw")
									writable = decompressor.writable.getWriter()
								}
								break
							case 9:
								if (offsetSize > buffer.length - index) {
									writable.write(buffer.slice(index, buffer.length))
									offsetSize -= buffer.length - index
									index = buffer.length
								} else {
									writable.write(buffer.slice(index, index += offsetSize))
									writable.close()
									writable.releaseLock()
									await callback(name, decompressor.readable)

									headerSuccess = false
									currentHeader = pkHeader
									offsetSize = 0
								}
								break
						}
					}
				}

				if (result.done) {
					reader.releaseLock()
					resolve()
				}
			}
		}).catch(reject)
	})
}

function distance(lat1, lon1, lat2, lon2) {
	return Math.asin(Math.sqrt(Math.sin((lat2 - lat1) * rad * 0.5) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad * 0.5) ** 2))
}

function parse(skip) {
	getFiles("./SEQ_GTFS.zip", async (name, reader) => {
		name = name.slice(0, -4)
		if (name != "stops" && name != "trips" && name != "stop_times" && name != "shapes" || (skip && skip.includes(name))) return
		var string = ""
		var transaction, result, temp1, temp2, temp3

		reader = reader.pipeThrough(new TextDecoderStream()).getReader()
		while (true) {
			result = await reader.read()
			string += result.value

			if (result.done) {
				reader.releaseLock()
				var result = Papa.parse(string, {
					delimiter: ",",
					newline: "\r\n",
					header: true,
					skipEmptyLines: "greedy"
				})

				console.log(name)
				result.errors.forEach((error) => {
					if (error.row) {
						delete result.data[error.row]
						result.data.length--
					}
				})

				switch (name) {
					case "shapes":
						string = result.data
						result = {}
						temp1 = 0
						temp3 = string[0].shape_id

						string.forEach((shape) => {
							if (shape.shape_id != temp3) {
								temp1 = 1 / temp1
								temp2 = 0
								result[temp3].forEach((shape) => temp2 = (shape.distance = shape.distance * temp1 + temp2))
								temp1 = 0
								temp2 = null
							}
							if (temp2) temp1 += (shape.distance = distance(temp2.shape_pt_lat, temp2.shape_pt_lon, shape.shape_pt_lat, shape.shape_pt_lon))
							else shape.distance = 0
							if (result[shape.shape_id]) result[shape.shape_id].push(shape)
							else result[shape.shape_id] = [shape]
							temp2 = shape
							temp3 = shape.shape_id
						})
						break
					case "stop_times":
						string = result.data
						result = {}

						string.forEach((stopTime) => {
							if (result[stopTime.trip_id]) result[stopTime.trip_id].push(stopTime)
							else result[stopTime.trip_id] = [stopTime]
						})
						break
					default:
						result = result.data
				}

				transaction = openRequest.result.transaction("files", "readwrite")
				transaction.onerror = console.error
				transaction.objectStore("files").put({ data: result, name })
				transaction.commit()
				break
			}
		}
	}).then(() => {
		openRequest.result.close()
		postMessage("complete")
	}).catch(console.error)
}

importScripts("papaparse.min.js")
openRequest.onerror = console.error
openRequest.onupgradeneeded = (event) => event.target.result.createObjectStore("files", { keyPath: "name" })
openRequest.onsuccess = () => {
	var primaryTransaction = openRequest.result.transaction("files", "readonly")
	primaryTransaction.onerror = (event) => {
		console.error(event)
		parse()
	}

	var primaryResult = primaryTransaction.objectStore("files").getAllKeys()
	primaryResult.onsuccess = () => {
		parse(primaryResult.result)
	}

	primaryResult.onerror = (event) => {
		console.error(event)
		parse()
	}
}