const http = require('http')
const EventEmitter = require('events')
const Ssdp = require('node-ssdp').Client
const mdns = require('multicast-dns')
const parseString = require('xml2js').parseString
const txt = require('dns-txt')()
const debug = require('debug')('chromecast-api')
const Device = require('./device')

const UUID_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

const UUID_REGEX_NO_HYPENS = /[0-9a-f]{32}/i

const SSDP_DEVICE_TYPE = 'urn:dial-multiscreen-org:device:dial:1'

/**
 * Chromecast client
 */
class Client extends EventEmitter {
  constructor(options = {}) {
    super()
    debug('Initializing...')

    // Internal storage
    this._devices = {}

    // Public
    this.devices = []

    // MDNS host strategy
    this._mdns_host_stategy = options.mdns_host_stategy || 'rinfo'

    // Query MDNS
    let mdns_enabled = true
    if ('mdns_enabled' in options) {
      mdns_enabled = options.mdns_enabled
    }

    if (mdns_enabled) {
      this.queryMDNS()
    }

    // SSDP Device Endpoint HTTP Timeout
    this._ssdp_device_endpoint_http_timeout =
      options.ssdp_device_endpoint_http_timeout || 5000

    // Query SSDP
    let ssdp_enabled = true
    if ('ssdp_enabled' in options) {
      ssdp_enabled = options.ssdp_enabled
    }

    if (ssdp_enabled) {
      this.querySSDP()
    }

    if (options.gc_interval > 0 && options.gc_threshold > 0) {
      this.gcIntervalRef = setInterval(() => {
        debug('garbage collecting old devices')
        this.devices.forEach((device, index) => {
          const now = Math.floor(Date.now() / 1000)
          const lastSeen = device.last_seen

          if (lastSeen) {
            if (now - lastSeen > options.gc_threshold) {
              debug('garbage collecting device', device)
              try {
                device.close()
              } catch (err) {
                err
                // do nothing
              }

              delete this._devices[device.name]
              this.devices.splice(index, 1)
              this.emit('device_offline', device)
            }
          }
        })
      }, 1000 * options.gc_interval)
    }

    if (options.update_interval > 0) {
      this.updateIntervalRef = setInterval(() => {
        this.update()
      }, 1000 * options.update_interval)
    }
  }

  _updateDevice(uuid) {
    const device = this._devices[uuid]
    const lastSeen = Math.floor(Date.now() / 1000)

    //console.log('_updateDevice invoked', uuid)

    // Get existing device if already on the stack
    let oDevice
    oDevice = this.devices.find((v) => {
      return v.uuid == uuid
    })

    let emitEvent = false
    let emitUpdatedEvent = false
    let emitOnlineEvent = false

    if (oDevice) {
      debug('Update device: ', device)

      if (
        device.discoveryName != oDevice.name ||
        device.friendlyName != oDevice.friendlyName ||
        device.host != oDevice.host ||
        device.manufacturer != oDevice.manufacturer ||
        device.modelName != oDevice.modelName
      ) {
        emitUpdatedEvent = true
        emitEvent = true
      }

      //console.log('updating device', device, oDevice, emitEvent)

      oDevice.name = device.discoveryName
      oDevice.friendlyName = device.friendlyName
      oDevice.host = device.host
      oDevice.manufacturer = device.manufacturer
      oDevice.modelName = device.modelName
      oDevice.lastSeen = lastSeen
    } else {
      debug('New device: ', device)

      emitEvent = true
      emitOnlineEvent = true

      // Add new device
      oDevice = new Device({
        uuid,
        name: device.discoveryName,
        friendlyName: device.friendlyName,
        host: device.host,
        manufacturer: device.manufacturer,
        modelName: device.modelName,
        lastSeen: lastSeen,
      })

      // Add for public storage
      this.devices.push(oDevice)
    }

    if (emitEvent) {
      this.emit('device', oDevice)
    }

    if (emitOnlineEvent) {
      this.emit('device_online', oDevice)
    }

    if (emitUpdatedEvent) {
      this.emit('device_updated', oDevice)
    }
  }

  parseUUID(data) {
    let uuid
    let matches

    if (!uuid) {
      matches = data.match(UUID_REGEX)
      if (matches) {
        uuid = matches[0].replace('-', '')
      }
    }

    if (!uuid) {
      matches = data.match(UUID_REGEX_NO_HYPENS)
      if (matches) {
        uuid = matches[0]
      }
    }

    if (!uuid) {
      uuid = data
    }

    return uuid
  }

  queryMDNS() {
    debug('Querying MDNS...')

    // MDNS
    this._mdns = mdns()
    this._mdns.on('response', (response, rinfo) => {
      const onEachAnswer = (a) => {
        const host = rinfo.address
        let uuid
        let discoveryName

        //console.log('mdns answer', a)

        switch (a.type) {
          case 'PTR':
            if (a.name === '_googlecast._tcp.local') {
              debug('DNS [PTR]: ', a)

              uuid = this.parseUUID(a.data)
              discoveryName = a.data
              if (!this._devices[uuid]) {
                // New device
                this._devices[uuid] = {
                  friendlyName: null,
                  host: null,
                  uuid,
                  discoveryName,
                }
              } else {
                if (discoveryName)
                  this._devices[uuid].discoveryName = discoveryName

                // do NOT announce until we have sufficient data
                if (
                  this._devices[uuid].host &&
                  this._devices[uuid].friendlyName
                )
                  this._updateDevice(uuid)
              }
            }
            break
          case 'SRV':
            uuid = this.parseUUID(a.name)
            discoveryName = a.name

            if (this._devices[uuid]) {
              debug('DNS [SRV]: ', a)

              // Update device
              switch (this._mdns_host_stategy.toLowerCase()) {
                case 'srv':
                  this._devices[uuid].host = a.data.target
                  break
                case 'rinfo':
                default:
                  this._devices[uuid].host = host
                  break
              }

              if (discoveryName)
                this._devices[uuid].discoveryName = discoveryName

              // do NOT announce until we have sufficient data
              if (this._devices[uuid].host && this._devices[uuid].friendlyName)
                this._updateDevice(uuid)
            }

            break
          case 'TXT':
            uuid = this.parseUUID(a.name)
            discoveryName = a.name

            if (this._devices[uuid]) {
              debug('DNS [TXT]: ', a)

              // Fix for array od data
              let decodedData = {}
              if (Array.isArray(a.data)) {
                a.data.forEach((item) => {
                  const decodedItem = txt.decode(item)
                  Object.keys(decodedItem).forEach((key) => {
                    decodedData[key] = decodedItem[key]
                  })
                })
              } else {
                decodedData = txt.decode(a.data)
              }

              //console.log(decodedData)

              const friendlyName = decodedData.fn || decodedData.n
              const modelName = decodedData.d

              // Update device
              if (discoveryName)
                this._devices[uuid].discoveryName = discoveryName
              if (friendlyName) this._devices[uuid].friendlyName = friendlyName
              if (modelName && !this._devices[uuid].modelName)
                // prefer SSDP data over MDNS data
                this._devices[uuid].modelName = modelName

              // do NOT announce until we have sufficient data
              if (this._devices[uuid].host && this._devices[uuid].friendlyName)
                this._updateDevice(uuid)
            }
            break
        }
      }

      response.answers.forEach(onEachAnswer)
      response.additionals.forEach(onEachAnswer)
    })

    // Query MDNS
    this._triggerMDNS()
  }

  _triggerMDNS() {
    if (this._mdns) this._mdns.query('_googlecast._tcp.local', 'PTR')
  }

  querySSDP() {
    debug('Querying SSDP...')

    // SSDP
    this._ssdp = new Ssdp()
    this._ssdp.on('response', (headers, statusCode, rinfo) => {
      if (statusCode !== 200 || !headers.LOCATION) return

      const host = rinfo.address

      http.get(
        headers.LOCATION,
        {
          timeout: this._ssdp_device_endpoint_http_timeout,
          signal: AbortSignal.timeout(this._ssdp_device_endpoint_http_timeout),
        },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res
            .on('end', () => {
              //console.log('ssdp response body', body.toString())
              parseString(
                body.toString(),
                { explicitArray: false, explicitRoot: false },
                (err, result) => {
                  if (err) return
                  if (
                    !result.device ||
                    result.device.deviceType != SSDP_DEVICE_TYPE ||
                    !result.device.friendlyName
                  )
                    return

                  //console.log('ssdp result', result.device)

                  // Manufacturer
                  const manufacturer = result.device.manufacturer

                  // Model Name
                  const modelName = result.device.modelName

                  // Friendly name
                  const friendlyName = result.device.friendlyName

                  // UDN
                  const udn = result.device.UDN

                  // Generate chromecast style name
                  // Note that if we later receive MDNS data for this same device it will be preferred over this generated name
                  const discoveryName = `Chromecast-${udn.replace(/uuid:/g, '').replace(/-/g, '')}._googlecast._tcp.local`

                  if (!friendlyName) return
                  if (!udn) return

                  const uuid = this.parseUUID(
                    udn.replace(/uuid:/g, '').replace(/-/g, '')
                  )

                  if (!this._devices[uuid]) {
                    // New device
                    this._devices[uuid] = {
                      discoveryName,
                      friendlyName,
                      host,
                      manufacturer,
                      modelName,
                    }
                    this._updateDevice(uuid)
                  } else {
                    // Update device
                    if (discoveryName && !this._devices[uuid].discoveryName)
                      // prefer MDNS data
                      this._devices[uuid].discoveryName = discoveryName
                    if (friendlyName)
                      this._devices[uuid].friendlyName = friendlyName
                    if (host) this._devices[uuid].host = host
                    if (manufacturer)
                      this._devices[uuid].manufacturer = manufacturer
                    if (modelName) this._devices[uuid].modelName = modelName
                    this._updateDevice(uuid)
                  }
                }
              )
            })
            .on('error', (err) => {
              debug(
                `failed executing SSDP http request: url=${headers.LOCATION}, err=${err}`
              )
              return
            })
        }
      )
    })

    // Query SSDP
    this._triggerSSDP()
  }

  _triggerSSDP() {
    if (this._ssdp) this._ssdp.search(SSDP_DEVICE_TYPE)
  }

  update() {
    // Trigger again MDNS
    this._triggerMDNS()

    // Trigger again SSDP
    this._triggerSSDP()
  }

  destroy() {
    clearInterval(this.gcIntervalRef)
    clearInterval(this.updateIntervalRef)

    this.removeAllListeners()

    if (this._mdns) {
      this._mdns.removeAllListeners()
      this._mdns.destroy()
      this._mdns = null
    }

    if (this._ssdp) {
      this._ssdp.removeAllListeners()
      this._ssdp.stop()
      this._ssdp = null
    }
  }
}

module.exports = Client
