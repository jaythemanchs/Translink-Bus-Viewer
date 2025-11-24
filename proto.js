const decoder = new TextDecoder("ascii")

function toDate(n) {
	return new Date(Number(n * 1000n))
}

export function getFeed(url) {
	return new Promise((resolve, reject) => {
		fetch(url, {
			cache: "no-cache",
			referrerPolicy: "unsafe-url"
		}).then((res) => {
			res.bytes().then((array) => {
				const buffer = new Buffer(array)
				resolve(new FeedMessage(buffer, buffer.buffer.length))
			}).catch(reject)
		}).catch(reject)
	})
}

export class Buffer {
	/**
	 * Creates a new Buffer from an ArrayBuffer or Uint8Array.
	 * @param {ArrayBuffer|Uint8Array} arrayLike
	 */
	constructor(arrayLike) {
		this.buffer = arrayLike instanceof ArrayBuffer ? new Uint8Array(arrayLike) : arrayLike
	}

	/**
	 * The actual buffer data.
	 * @type {Uint8Array}
	 */
	buffer

	/**
	 * The Buffer offset.
	 */
	offset = 0

	/**
	 * Returns a slice of the buffer data.
	 * @param {number} start The starting byte index if `end` is supplied, or the byte count relative to `this.offset`.
	 * @param {number?} end The ending byte.
	 * @returns {Uint8Array} The sliced portion of the buffer.
	 */
	slice(start, end) {
		return end ? this.buffer.slice(start, end) : this.buffer.slice(this.offset, this.offset += start)
	}

	/**
	 * 
	 * @param offset The desired buffer offset.
	 * @returns A BigInt
	 */
	readVarInt(offset = this.offset) {
		var result = 0n
		var shift = -7
		var byte

		do {
			byte = this.buffer[offset++]
			result += BigInt(byte & 0x7f) * (2n ** BigInt(shift += 7))
		} while (byte >= 0x80)

		return this.offset = offset, result
	}

	i(index) {
		return this.buffer[index]
	}
}

class Message {
	/**
	 * Creates a Message
	 * @param {Buffer} buffer The source Buffer for the Message
	 * @param {number} size The size of the Message
	 */
	constructor(buffer, size) {
		this.buffer = buffer
		var result = 0n
		var end = buffer.offset + size
		var index, type

		this.init()
		while (buffer.offset < end) {
			result = buffer.readVarInt()
			type = Number(result & 0b111n)
			index = Number(result >> 3n)

			this.parse(index, buffer.offset, () => {
				switch (type) {
					case 0:
						return buffer.readVarInt()
					case 2:
						return buffer.slice(Number(buffer.readVarInt()))
					case 5:
						return buffer.slice(4)
					case 1:
						return buffer.slice(8)
				}
			})
		}
	}

	parse() { }
	init() {}

	/**
	 * @template T
	 * @param {T} c 
	 * @returns {T["prototype"]}
	 * @protected
	 */
	newClass(c) {
		return new c(this.buffer, Number(this.buffer.readVarInt()))
	}

	/**
	 * The source buffer.
	 * @type {Buffer}
	 */
	buffer
}

export class FeedMessage extends Message {
	init() {
		this.entities = {}
	}
	parse(index) {
		switch (index) {
			case 1:
				this.header = this.newClass(FeedHeader)
				break
			case 2:
				let entity = this.newClass(FeedEntity)
				this.entities[entity.id] = entity
				break
		}
	}
}

class FeedHeader extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.version = decoder.decode(def())
				break
			case 2:
				this.incrementality = Number(def())
				break
			case 3:
				this.timestamp = toDate(def())
				break
		}
	}
}

export class FeedEntity extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.id = decoder.decode(def())
				break
			case 2:
				this.deleted = Boolean(def())
				break
			case 3:
				this.tripUpdate = this.newClass(TripUpdate)
				break
			case 4:
				this.vehicle = this.newClass(VehiclePosition)
				break
			case 5:
				this.alert = this.newClass(Alert)
				break
		}
	}
}

class TripUpdate extends Message {
	init() {
		this.stopTimeUpdates = []
	}
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.trip = this.newClass(TripDescriptor)
				break
			case 2:
				this.stopTimeUpdates.push(this.newClass(StopTimeUpdate))
				break
			case 3:
				this.vehicle = this.newClass(VehicleDescriptor)
				break
			case 4:
				this.timestamp = toDate(def())
				break
			case 5:
				this.delay = Number(def())
				break
		}
	}
}

class StopTimeEvent extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.delay = Number(def())
				break
			case 2:
				this.timestamp = toDate(def())
				break
			case 3:
				this.uncertainty = Number(def())
				break
		}
	}
}

class StopTimeUpdate extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.stopSequence = Number(def())
				break
			case 2:
				this.arrival = this.newClass(StopTimeEvent)
				break
			case 3:
				this.departure = this.newClass(StopTimeEvent)
				break
			case 4:
				this.stopId = decoder.decode(def())
				break
			case 5:
				this.relationship = Number(def())
				break
		}
	}
}

class VehiclePosition extends Message {
	static status = ["Arriving", "Stopped", "Departed"]
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.tripDescriptor = this.newClass(TripDescriptor)
				break
			case 2:
				this.position = this.newClass(Position)
				break
			case 3:
				this.currentStopSequence = Number(def())
				break
			case 4:
				this.status = VehiclePosition.status[Number(def())]
				break
			case 5:
				this.timestamp = toDate(def())
				break
			case 6:
				this.congestion = Number(def())
				break
			case 7:
				this.stopId = decoder.decode(def())
				break
			case 8:
				this.vehicle = this.newClass(VehicleDescriptor)
				break
			case 9:
				this.occupancyStatus = Number(def())
				break
			case 10:
				this.occupancyPercentage = Number(def())
				break
		}
	}
}

class Alert extends Message {
	init() {
		this.informed = []
	}
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.activePeriod = this.newClass(TimeRange)
				break
			case 5:
				this.informed.push(this.newClass(EntitySelector))
				break
			case 6:
				this.cause = Number(def())
				break
			case 7:
				this.effect = Number(def())
				break
			case 8:
				this.url = this.newClass(TranslatedString)
				break
			case 10:
				this.header = this.newClass(TranslatedString)
				break
			case 11:
				this.description = this.newClass(TranslatedString)
				break
			case 14:
				this.severity = Number(def())
				break
		}
	}
}

class TimeRange extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.start = toDate(def())
				break
			case 2:
				this.end = toDate(def())
				break
		}
	}
}

class Position extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.latitude = new Float32Array(def().buffer)[0]
				break
			case 2:
				this.longitude = new Float32Array(def().buffer)[0]
				break
			case 3:
				this.bearing = Number(def())
				break
			case 4:
				this.odometer = Number(def())
				break
			case 5:
				this.speed = Number(def())
				break
		}
	}
}

class TripDescriptor extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.tripId = decoder.decode(def())
				break
			case 2:
				this.startTime = decoder.decode(def())
				break
			case 3:
				this.startDate = decoder.decode(def())
				break
			case 4:
				this.relationship = Number(def())
				break
			case 5:
				this.routeId = decoder.decode(def())
				break
			case 6:
				this.directionId = Number(def())
				break
		}
	}
}

class VehicleDescriptor extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.id = decoder.decode(def())
				break
			case 2:
				this.label = decoder.decode(def())
				break
			case 3:
				this.licensePlate = decoder.decode(def())
				break
		}
	}
}

class EntitySelector extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.agencyId = decoder.decode(def())
				break
			case 2:
				this.routeId = decoder.decode(def())
				break
			case 3:
				this.routeType = Number(def())
				break
			case 4:
				this.trip = this.newClass(TripDescriptor)
				break
			case 5:
				this.stopId = decoder.decode(def())
				break
			case 6:
				this.directionId = Number(def())
				break
		}
	}
}

class TranslatedString extends Message {
	init() {
		this.translations = []
	}
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.translations.push(this.newClass(Translation))
				break
		}
	}
}

class Translation extends Message {
	parse(index, _, def) {
		switch (index) {
			case 1:
				this.text = decoder.decode(def())
				break
			case 2:
				this.language = decoder.decode(def())
				break
		}
	}
}