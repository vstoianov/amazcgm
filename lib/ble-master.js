/** @about BLE Master 1.7.8 @min_zeppos 3.0 @author: Silver, Zepp Health. @license: MIT */
import * as hmBle from '@zos/ble'
import {
	rememberBlePid,
	getBlePids,
	setBleConnectId,
	getBleConnectId,
	clearBlePids,
	forgetBlePid
} from '../shared/session'
import { trace } from '../shared/trace'

// DEBUG_LOG_PRIORITY levels:
// 0 - No logs
// 1 - Critical errors only
// 2 - Errors and warnings
// 3 - All logs (including debug information)
// Can also be changed with BLEMaster.SetDebugLevel(3) 
let DEBUG_LOG_LEVEL = 1; // set to 0 if you need no logs

function isPrivateFieldError(err) {
	const m = err && err.message ? String(err.message) : ''
	return m.indexOf('private field') >= 0
}


//  backend status codes
const BX_CORE_CODES = {
	"-10": { message: "Missing Attribute", code: "BX_CORE_MISS_ATT" },
	"-9": { message: "System Error", code: "BX_CORE_SYS" },
	"-8": { message: "Authentication Error", code: "BX_CORE_AUTH" },
	"-7": { message: "Invalid Parameter", code: "BX_CORE_PARAM" },
	"-6": { message: "Invalid Operation", code: "BX_CORE_INVALID" },
	"-5": { message: "Invalid State", code: "BX_CORE_STATE" },
	"-4": { message: "Busy", code: "BX_CORE_BUSY" },
	"-3": { message: "Timeout", code: "BX_CORE_TIMEOUT" },
	"-2": { message: "Uninitialized", code: "BX_CORE_UNINIT" },
	"-1": { message: "Fail", code: "BX_CORE_FAIL" },
	"0": { message: "Success", code: "BX_CORE_SUCCESS" }
};

// err prefixes
const ERR_PREFIX = "ERR: ";
const WARN_PREFIX = "WARN: "; // @add 1.6.9

const ERR = {
	PID_NOT_FOUND: ERR_PREFIX + "The profile pointer ID is not found for this MAC address. Please use startListener before trying to write char/desc!",
	PROFILE_CREATION_FAILED: ERR_PREFIX + "Profile creation failed",
	DEVICE_NOT_CONNECTED: ERR_PREFIX + "Device not connected. Please connect before attempting this operation.",
	INVALID_MAC_ADDR: ERR_PREFIX + "Invalid MAC address format",
	DEVICE_NOT_FOUND: ERR_PREFIX + "Device not found",
	DEVICE_ADDR_UNDEFINED: ERR_PREFIX + "Device address is undefined",
	CHAR_WRITE_OPERATION_TIMEOUT: ERR_PREFIX + "Characteristic write operation timeout. Make sure to subscribe to the .on.charaWriteComplete(...) event!",
	CHAR_READ_OPERATION_TIMEOUT: ERR_PREFIX + "Characteristic read operation timeout. Make sure to subscribe to either the .on.charaValueArrived(...) or .on.charaReadComplete(...) event!",
	DESC_WRITE_OPERATION_TIMEOUT: ERR_PREFIX + "Descriptor write operation timeout. Make sure to subscribe to the .on.descWriteComplete(...) event!",
	DESC_READ_OPERATION_TIMEOUT: ERR_PREFIX + "Descriptor read operation timeout. Make sure to subscribe to either the .on.descValueArrived(...) or .on.descReadComplete(...) event!",
	NOT_A_FUNCTION: ERR_PREFIX + "You have to provide a callback function",
	CB_DEREGISTERED: ERR_PREFIX + "You are trying to execute a callback that was deregistered",
	DEPRECATED: WARN_PREFIX + "This method is deprecated and will be removed in the future.",
};

// Official Zepp mstOn* callbacks are positional (profile, uuid, data, …).
// Older firmware / easy-ble examples also pass a single object. Accept both.
function isPlainBleObject(value) {
	if (value == null || typeof value !== 'object') return false;
	if (value instanceof ArrayBuffer) return false;
	if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) return false;
	return true;
}

function asBleEvent(a, b, c, d, named) {
	if (isPlainBleObject(a)) {
		if (a.chara == null && a.uuid != null && named.indexOf('chara') >= 0) a.chara = a.uuid;
		if (a.desc == null && (a.descUUID != null || a.desc_uuid != null)) a.desc = a.descUUID || a.desc_uuid;
		return a;
	}
	const ev = {};
	let keys = named;
	const args = [a, b, c, d];
	if (typeof a === 'string' && named[0] === 'profile') {
		ev.profile = null;
		keys = named.slice(1);
	}
	for (let i = 0; i < keys.length; i++) ev[keys[i]] = args[i];
	return ev;
}

/**
 * BLEMaster class for managing Bluetooth Low Energy (BLE) operations.
 * This class provides methods for scanning, connecting, and interacting with BLE devices.
 */
export class BLEMaster {
	#devices = {};
	#last_connected_mac = null;
	#connection_in_progress = false;
	#connection_started_at = 0;
	#connectGen = 0;
	#listener_starting = false;
	#prepare_starting = false;
	#is_scanning = false;
	#device_set = new Set(); // filter uniques
	#get_helper; // @add 1.6.7
	#notifySink = null;
	#notifyAttached = false;
	#descSink = null;
	#descAttached = false;

	/**
	 * Creates an instance of BLEMaster.
	 * Initializes internal state and sets up write and read operations.
	 */
	constructor() {
		const queueManager = new QueueManager();
		this.write = new Write(() => this.#getCurrentlyConnectedDevice(), queueManager);
		this.read = new Read(() => this.#getCurrentlyConnectedDevice(), queueManager);
	}

	/**
	 * @type {Write} A device writer.
	 */
	write;

	/**
	 * @type {Read} A device reader.
	 */
	read;

	/**
	 * @type {On} An instance for handling BLE event callbacks.
	 */
	on;

	/**
	 * @type {Off} An instance for deregistering BLE event callbacks.
	 */
	off;

	/**
	 * @type {Get} A device information getter.
	 */
	get get() {
		try {
			if (!this.#get_helper) { // cache
				this.#get_helper = new Get(this.#getDevices, () => this.#getCurrentlyConnectedDevice());
			}
			return this.#get_helper;
		} catch (e) {
			if (isPrivateFieldError(e)) {
				return { isConnected: () => false }
			}
			throw e
		}
	}

	/**
	 * Starts scanning for BLE devices.
	 * @param {Function} response_callback - Callback function called with each device's scan result.
	 * @param {Object} [options={}] - Optional parameters for the scan.
	 * @param {number} [options.duration] - Duration of the scan in milliseconds. Auto-stops after this duration.
	 * @param {Function} [options.on_duration] - Callback function called when the scan stops after the specified duration.
	 * @param {number} [options.throttle_interval=1000] - Interval in milliseconds to throttle the processing of scan results.
	 * @param {boolean} [options.allow_duplicates=false] - Whether to include duplicate devices in each callback. Defaults to false.
	 * @example
	 * // example: start scanning for devices and log each found device
	 * ble.startScan((device) => { console.log('Found device:', device); }); 
	 * 
	 * // advanced example: start scanning for 10 seconds with a custom throttle interval and allow duplicates, then stop and log
	 * ble.startScan((device) =>  { console.log('Found device during scan:', device); }, 
	 *            { duration: 10000, throttle_interval: 500, allow_duplicates: true, on_duration: () => console.log('Scan complete') });
	 * @returns {boolean} true if the scan started successfully, false otherwise.
	 */
	startScan(response_callback, options = {}) {
		debugLog(3, "Starting scan");

		this.#device_set.clear();
		this.#is_scanning = true;

		// default options
		const { throttle_interval = 1000, duration, on_duration, allow_duplicates = false } = options; // @add 1.6.1

		let device_batch = [];
		let timer_started = false; // @fix 1.6.0

		const modified_callback = (scan_result) => {
			try {
				if (!scan_result || !scan_result.dev_addr) return;
				const mac_address = ab2mac(scan_result.dev_addr);
				const raw_uuid = scan_result.uuid;
				const uuid_str =
					raw_uuid == null
						? ''
						: typeof raw_uuid === 'number'
							? raw_uuid.toString(16)
							: String(raw_uuid);
				const scan_result_mod = {
					...scan_result,
					uuid: uuid_str,
					dev_addr: mac_address,
					vendor_data: scan_result.vendor_data
						? ab2str_stripped(scan_result.vendor_data)
						: '',
					service_data_array: scan_result.service_data_array
						? scan_result.service_data_array.map((service) => ({
								...service,
								service_data: service.service_data
									? ab2str_stripped(service.service_data)
									: ''
							}))
						: []
				};

				if (!this.#device_set.has(mac_address)) {
					debugLog(3, `Adding new device ${mac_address}`);
					this.#device_set.add(mac_address);
					this.#devices[mac_address] = scan_result_mod;
					response_callback(scan_result_mod);
				} else if (allow_duplicates) {
					this.#devices[mac_address] = scan_result_mod;
					device_batch.push(scan_result_mod);

					if (!timer_started) {
						debugLog(3, `Starting throttle timer at ${new Date().toISOString()}`);
						timer_started = true;
						setTimeout(() => {
							debugLog(3, `Processing batch at ${new Date().toISOString()}`);
							device_batch.forEach((device) => response_callback(device));
							device_batch = [];
							timer_started = false;
						}, throttle_interval);
					}
				}
			} catch (e) {
				debugLog(1, 'Scan callback error', e && e.message ? e.message : e);
			}
		};

		const filter = options.filter;
		const success = filter
			? hmBle.mstStartScan(modified_callback, filter)
			: hmBle.mstStartScan(modified_callback);

		if (duration !== undefined) {
			setTimeout(() => {
				this.stopScan();
				if (on_duration) {
					on_duration();
				}
			}, duration);
		}
		return success;
	}

	/**
	 * Stops the ongoing scanning process for BLE devices.
	 * This method should be called to terminate a scan started by `startScan` method, especially if the scan was initiated without a specified duration.
	 * @example
	 * // example: simply stop the scan
	 * ble.stopScan();
	 * // advanced example: start scanning for devices and then stop scanning after the device was found
	 * ble.startScan((device) => {
	 *   if (.get.hasMAC("1A:2B:3C:4D:5E:6F")) .stopScan();
	 * });
	 * @returns {boolean} true if the scan was successfully stopped, false if there was an error in stopping the scan.
	 */
	stopScan() {
		this.#device_set.clear();
		if (this.#is_scanning) {
			this.#is_scanning = false;
			return hmBle.mstStopScan();
		} return false;
	}

	/**
	 * Attempts to connect to a BLE device.
	 * @param {string} dev_addr - The MAC address of the device to connect to.
	 * @param {function} response_callback - Callback function that receives the result of the connection attempt.
	 *   The callback is called with an object containing two properties:
	 *   - `connected`: A boolean indicating if the connection was successful.
	 *   - `status`: A string indicating the connection status. Possible values are `connected`, `invalid mac`, 
	 *     `in progress`, `failed`, or `disconnected`. 
	 * @example
	 * // example: connect to a device and log the result
	 * ble.connect("1A:2B:3C:4D:5E:6F", (result) => {
	 *   if (result.connected) {
	 *     console.log('Connected to device');
	 *   } else {
	 *     console.log('Failed to connect. Status:', result.status);
	 *   }
	 * });
	 * @returns {boolean} true if the connection attempt started successfully, false otherwise.
	 */
	connect(dev_addr, response_callback) {
		try {
			return this.#connectInner(dev_addr, response_callback)
		} catch (e) {
			if (isPrivateFieldError(e)) {
				if (response_callback) response_callback({ connected: false, status: 'failed' })
				return false
			}
			throw e
		}
	}

	#connectInner(dev_addr, response_callback) {
		if (!dev_addr) {
			debugLog(1, ERR.DEVICE_ADDR_UNDEFINED);
			return false;
		}

		debugLog(3, `Attempting to connect to device: ${dev_addr}`);
		dev_addr = dev_addr.toLowerCase();

		// if dev_addr is a pattern, find the first device that matches the pattern
		if (dev_addr.includes('xx')) { // @add 1.5.7
			const matched_dev_addr = findMatchingMacAddress(this.#devices, dev_addr);
			if (!matched_dev_addr) {
				debugLog(1, ERR.DEVICE_NOT_FOUND, dev_addr);
				response_callback({ connected: false, status: "device not found" });
				return false;
			}
			dev_addr = matched_dev_addr;
		}

		// Skip mstConnect only when this MAC still has a live connect_id.
		// After dropLink, is_connected can be stale while last_connected_mac
		// is gone — that used to fake "connected" and then Profile failed.
		const cur = this.#last_connected_mac ? String(this.#last_connected_mac).toLowerCase() : ''
		const held = cur && cur === dev_addr ? this.#devices[cur] : null
		if (held && held.is_connected && typeof held.connect_id === 'number' && held.connect_id >= 0) {
			debugLog(2, "Device already connected:", dev_addr);
			response_callback({ connected: true, status: "connected" });
			return true;
		}

		// check if provided MAC looks valid 
		if (!isValidMacAddress(dev_addr)) {
			debugLog(1, ERR.INVALID_MAC_ADDR, dev_addr);
			response_callback({ connected: false, status: "invalid mac" });
			return false;
		}

		if (this.#connection_in_progress) {
			const age = Date.now() - this.#connection_started_at
			if (age < 8000) {
				debugLog(2, "Connection already in progress for:", dev_addr);
				response_callback({ connected: false, status: "in progress" });
				return false;
			}
			debugLog(2, "Stale connection lock, retrying", dev_addr);
			this.#connection_in_progress = false;
		}

		this.#initiateConnection(dev_addr, response_callback);
		return true;
	}

	/** Abort a hanging mstConnect so the next scan/connect can start. */
	abortConnect() {
		this.#connection_in_progress = false;
		this.#connection_started_at = 0;
		try {
			hmBle.mstOffAllCb();
		} catch (e) {}
		try {
			this.disconnect();
		} catch (e) {}
	}

	/**
	 * Disconnects from a BLE device.
	 * @example
	 * // example: disconnect from a device
	 * ble.disconnect();
	 * @returns {boolean} true if the disconnection was successful, false if it failed or if the device was not connected.
	 */
	disconnect() {
		try {
			return this.#disconnectInner()
		} catch (e) {
			if (isPrivateFieldError(e)) return false
			throw e
		}
	}

	#disconnectInner() {
		this.#connection_in_progress = false;
		this.#connection_started_at = 0;
		if (!this.#last_connected_mac) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return false;
		}

		const device = this.#devices[this.#last_connected_mac];
		if (!device) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return false;
		}

		device.is_connected = false;
		let ok = false;
		try {
			if (typeof device.connect_id === 'number') {
				ok = !!hmBle.mstDisconnect(device.connect_id);
			}
		} catch (e) {
			ok = false;
		}
		// Keep #devices[mac] so the next mstConnect can reuse the entry.
		return ok;
	}

	/**
	 * Attempts to pair with a BLE device.
	 * WARNING: This method might not work as expected and could potentially cause crashes. Use with caution.
	 * TODO: Backend fix required for stable functionality (?)
	 * @example
	 * // example: attempt to pair with a device
	 * const success = ble.pair();
	 * if (success) console.log('Pairing initiated successfully');
	 * else console.log('Pairing failed or device not connected');
	 * @returns {boolean} Returns true if the call to initiate pairing with the device succeeded, false if it failed or if the device was not connected.
	 */
	pair() {
		const dev_addr = this.#last_connected_mac;
		debugLog(3, "Pairing with the device:", dev_addr);

		const device = this.#devices[dev_addr];
		if (!device || !device.is_connected || !dev_addr) {
			debugLog(ERR.DEVICE_NOT_CONNECTED);
			return false;
		}
		return hmBle.mstPair(device.connect_id);
	}

	/**
	 * Starts listening for profile preparation events and builds a profile for interacting with a BLE device.
	 * This method registers a callback to handle profile preparation and initiates the process to build a BLE profile based on the provided profile object.
	 *
	 * @param {Object} profile_object - The profile object describing how to interact with the BLE device. This should be generated using `generateProfileObject` method.
	 * @param {Function} response_callback - Callback function called with the result of the profile preparation. The callback receives an object containing 'success', 'message', and optionally 'code' properties.
	 * 
	 * @example
	 * // Example: start listener with a profile object
	 * const profile_object = ble.generateProfileObject(services); // detailed profile object
	 * ble.startListener(profile_object, (response) => {
	 *   if (response.success) {
	 *     console.log('Profile preparation successful:', response.message);
	 *   } else {
	 *     console.log('Profile preparation failed:', response.message, 'Code:', response.code);
	 *   }
	 * });
	 * 
	 * @returns {void} This method doesn't return a value but invokes the response callback with the result of the profile preparation.
	 */
	startListener(profile_object, response_callback) {
		// A leftover true from the last login made every later mstOnPrepare a
		// no-op, which is the "GATT login…" hang after the first attempt.
		this.#prepare_starting = false;
		this.#listener_starting = true;

		debugLog(3, "Starting listener with profile object", JSON.stringify(profile_object));

		let answered = false;
		const respond = (response) => {
			if (answered) return;
			answered = true;
			this.#listener_starting = false;
			this.#prepare_starting = false;
			response_callback(response);
		};

		const onPrep = hmBle.mstOnPrepare((a, b) => {
			response_callback({
				success: false,
				code: 'PREPARE_SEEN',
				message: isPlainBleObject(a)
					? 'obj p=' + a.profile + ' s=' + a.status
					: String(a) + ' ' + String(b)
			});
			let backend_response
			if (isPlainBleObject(a)) {
				backend_response = a
			} else if ((a === 0 || a === '0') && b != null && !isPlainBleObject(b)) {
				backend_response = { profile: b, status: 0 }
			} else {
				backend_response = { profile: a, status: b }
			}
			debugLog(2, "mstOnPrepare callback triggered", JSON.stringify(backend_response));

			const status_info = BX_CORE_CODES[String(backend_response.status)] ||
				{ message: "Unknown Error", code: "UNKNOWN" };

			const status = backend_response.status
			const prepared =
				status == 0 ||
				status === '0' ||
				(status == null && backend_response.profile != null)
			if (backend_response.profile != null && backend_response.profile !== '') {
				try {
					rememberBlePid(backend_response.profile)
				} catch (e) {}
			}
			if (prepared) {
				debugLog(2, "mstOnPrepare succeed, pointer ID:", backend_response.profile);
				if (this.#last_connected_mac && this.#devices[this.#last_connected_mac]) {
					this.#devices[this.#last_connected_mac].profile_pid = backend_response.profile;
				}
				try {
					// A second prepare must not replace On — that drops F002 listeners.
					if (!this.on) {
						this.on = new On(backend_response.profile);
						this.off = new Off();
					} else if (this.on.setPid) {
						this.on.setPid(backend_response.profile);
					}
				} catch (e) {
					debugLog(1, "On() after prepare threw", e && e.message);
				}
				respond({ success: true, message: status_info.message });
			} else {
				// Wear only gives up when discover status is a hard failure.
				// A busy/invalid-state prepare must not tear the link down.
				debugLog(1, `${status_info.message}. Status: ${status_info.code}`);
				response_callback({
					success: false,
					message: status_info.message,
					code: status_info.code,
					status
				});
			}
		});
		if (onPrep === false) {
			respond({ success: false, code: 'ONPREPARE_FALSE' });
			this.#listener_starting = false;
			return;
		}

		this.attachNotify(this.#notifySink);
		this.attachDescComplete(this.#descSink);
		try {
			const success = hmBle.mstBuildProfile(profile_object);
			debugLog(2, "mstBuildProfile called with success:", success);
			// Zepp often returns false here and still fires mstOnPrepare.
			// respond() would mark the login answered and swallow that prepare.
			if (success === false) {
				response_callback({ success: false, code: 'BUILD_FALSE' });
			} else {
				response_callback({ success: false, code: 'BUILD_OK' });
			}
		} catch (e) {
			debugLog(1, "mstBuildProfile threw", e && e.message);
			respond({ success: false, message: "Profile build threw", code: "BUILD_THREW" });
		}
		this.#listener_starting = false;
	}

	/**
	 * Register F002 notify at the native layer. Survives a second mstOnPrepare.
	 * Call before startListener so the stack has a sink when the profile is built.
	 */
	attachNotify(callback) {
		if (typeof callback === 'function') this.#notifySink = callback;
		if (this.#notifyAttached) return;
		this.#notifyAttached = true;
		hmBle.mstOnCharaNotification((a, b, c, d) => {
			const ev = asBleEvent(a, b, c, d, ['profile', 'uuid', 'data', 'length']);
			if (this.#notifySink) this.#notifySink(ev.uuid, ev.data, ev.length);
			else if (On._cb_charaNotification) On._cb_charaNotification(ev.uuid, ev.data, ev.length);
		});
	}

	/** Native CCCD-complete hook. Survives a second prepare; always logs. */
	attachDescComplete(callback) {
		if (typeof callback === 'function') this.#descSink = callback;
		if (this.#descAttached) return;
		this.#descAttached = true;
		hmBle.mstOnDescWriteComplete((a, b, c, d) => {
			const ev = asBleEvent(a, b, c, d, ['profile', 'chara', 'desc', 'status']);
			try {
				On._setDescWriteCompleteFlag(true);
			} catch (e) {}
			if (this.#descSink) this.#descSink(ev.chara, ev.desc, ev.status);
			if (On._cb_descWriteComplete) On._cb_descWriteComplete(ev.chara, ev.desc, ev.status);
		});
	}

	/** Drop a leftover GATT profile so the next mstBuildProfile can settle. */
	destroyProfile() {
		// mstDestroyProfileInstance drops the profile-bound notify/CCCD sinks.
		// Clear the flags so the next startListener registers them again.
		this.#notifyAttached = false
		this.#descAttached = false
		try {
			const device = this.#getCurrentlyConnectedDevice();
			if (device && device.profile_pid !== undefined) {
				const pid = device.profile_pid;
				hmBle.mstDestroyProfileInstance(pid);
				device.profile_pid = undefined;
				// Only pids never destroyed stay listed, so resetNative can free
				// leftovers without a double destroy.
				try { forgetBlePid(pid) } catch (e2) {}
			}
		} catch (e) {}
	}

	/**
	 * Free native GATT/ACL left by a previous JS process (sideload / page death).
	 * Only touches the current-process profile and the saved connect_id (an
	 * index, not a pointer). Always also frees slot 1 — that is the only id
	 * firmware has handed out across all logs, and later resets in a no-id
	 * chain still need it after the first reset. Keeps the saved connect id
	 * so a second resetNative can still disconnect the slot.
	 * Does not call mstOffAllCb — that latches later mstConnect after Live.
	 */
	resetNative(opts) {
		this.destroyProfile()
		this.#notifyAttached = false
		this.#descAttached = false
		if (opts && opts.freeAll) {
			try {
				hmBle.mstDisconnect(0)
			} catch (e) {}
			try {
				hmBle.mstDisconnect(1)
			} catch (e) {}
		}
		let savedId = -1
		try {
			savedId = getBleConnectId()
		} catch (e) {}
		if (savedId >= 0) {
			try {
				hmBle.mstDisconnect(savedId)
			} catch (e) {}
		}
		if (savedId !== 1) {
			try {
				hmBle.mstDisconnect(1)
			} catch (e) {}
		}
		if (opts && opts.freeAll && savedId !== 0) {
			try {
				hmBle.mstDisconnect(0)
			} catch (e) {}
		}
		// Profile instances that were prepared but never destroyed (page killed,
		// ignored drop, failed prepare) keep the old GATT/ACL slot busy: the next
		// link gets another id and mstBuildProfile returns false. Free them here
		// instead of only wiping the list.
		let leaked = []
		try {
			leaked = getBlePids()
		} catch (e) {}
		const freed = []
		for (let i = 0; i < leaked.length; i++) {
			try {
				const pid = leaked[i]
				const asNum = Number(pid)
				hmBle.mstDestroyProfileInstance(
					Number.isFinite(asNum) && String(asNum) === String(pid) ? asNum : pid
				)
				freed.push(pid)
			} catch (e) {}
		}
		if (leaked.length) {
			try {
				trace(
					'pids leaked=' +
						leaked.length +
						' ' +
						leaked.join(',') +
						' freed=' +
						freed.length +
						' cid=' +
						savedId
				)
			} catch (e) {}
		}
		try {
			clearBlePids()
		} catch (e) {}
		this.#connection_in_progress = false
		this.#connection_started_at = 0
		const device = this.#getCurrentlyConnectedDevice()
		if (device) {
			device.is_connected = false
			device.profile_pid = undefined
		}
		this.#last_connected_mac = null
	}

	/** Free a known ACL slot index. Safe even if the slot is already empty. */
	disconnectId(id) {
		const n = Number(id)
		if (!Number.isFinite(n) || n < 0) return false
		try {
			return !!hmBle.mstDisconnect(n)
		} catch (e) {
			return false
		}
	}

	/** Rebuild the same profile. Does not replace mstOnPrepare. */
	rebuildProfile(profile_object) {
		if (!profile_object) return false;
		try {
			return hmBle.mstBuildProfile(profile_object);
		} catch (e) {
			debugLog(1, "mstBuildProfile rebuild threw", e && e.message);
			return false;
		}
	}

	/**
	 * Generates a generic profile object for interacting with a BLE device.
	 * This method constructs a profile object that includes the device's characteristics and descriptors, along with their permissions.
	 * 
	 * @param {object} services - A list of services with their characteristics and descriptors. Each service is identified by its UUID and contains a map of its characteristics. Each characteristic, identified by its UUID, is an array of its descriptor UUIDs.
	 * @param {object} [permissions={}] - Optional. An object specifying custom permissions for characteristics and descriptors. If not provided, defaults to a permission value of 32 (all permissions) for each entry.
	 * 
	 * @example
	 * // example of generating a profile object for a device with custom permissions
	 * const services = {
	 *   'service_uuid': {
	 *     'char_uuid_1': ['desc_uuid_1', 'desc_uuid_2'],
	 *     'char_uuid_2': []
	 *   }
	 *   // other services...
	 * };
	 * const permissions = {
	 *   'char_uuid_1': PERMISSIONS.READ, // no need to provide perms for all UUIDs
	 * };
	 * const profile = ble.generateProfileObject(services, permissions);
	 * 
	 * @returns {object|null} A generic profile object for the device, or null if the device was not found. The profile object includes device connection information, services, characteristics, and their permissions.
	 */
	generateProfileObject(services, permissions = {}) {
		try {
			return this.#generateProfileObjectInner(services, permissions)
		} catch (e) {
			if (isPrivateFieldError(e)) return { success: false, error: 'private field' }
			throw e
		}
	}

	#generateProfileObjectInner(services, permissions = {}) {
		debugLog(3, "Generating full profile object");

		const dev_addr = this.#last_connected_mac;
		if (!dev_addr) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return { success: false, error: ERR.DEVICE_NOT_CONNECTED };
		}

		const device = this.#devices[this.#last_connected_mac];
		// check the device object
		if (!device) {
			debugLog(1, ERR.DEVICE_NOT_FOUND, dev_addr);
			return { success: false, error: ERR.DEVICE_NOT_FOUND + ": " + dev_addr };
		}

		// check if the device is connected
		if (!device.is_connected) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return { success: false, error: ERR.DEVICE_NOT_CONNECTED };
		}

		// 0 is a real firmware connect id. Reject only a missing or negative id
		// (a skipped mstConnect used to leave this undefined).
		if (typeof device.connect_id !== 'number' || !Number.isFinite(device.connect_id) || device.connect_id < 0) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return { success: false, error: 'bad connect id' };
		}

		const dev = mac2ab(dev_addr);
		if (!(dev instanceof ArrayBuffer) || dev.byteLength !== 6) {
			debugLog(1, ERR.INVALID_MAC_ADDR, dev_addr);
			return { success: false, error: ERR.INVALID_MAC_ADDR + ": " + dev_addr };
		}

		const serv_len = Object.keys(services).length;
		const profile_object = {
			pair: false,
			id: device.connect_id,
			profile: device.dev_name || "undefined",
			dev: dev,
			len: 1,
			list: [
				{
					uuid: true,
					size: serv_len,
					len: serv_len,
					list: []
				}
			]
		};

		for (let [serv_uuid, characteristics] of Object.entries(services)) {
			const chara_len = Object.keys(characteristics).length;
			const service = {
				uuid: serv_uuid,
				permission: 0,
				len1: chara_len,
				len2: chara_len,
				list: []
			};
			for (let [chara_uuid, desc_uuids] of Object.entries(characteristics)) {
				let chara_perm = permissions[chara_uuid] ? permissions[chara_uuid].value : 32;
				let characteristic = {
					uuid: chara_uuid,
					permission: chara_perm,
					desc: desc_uuids.length,
					len: desc_uuids.length
				};
				if (desc_uuids.length > 0) {
					characteristic.list = desc_uuids.map(descriptor_uuid => {
						let desc_perm = permissions[descriptor_uuid] ? permissions[descriptor_uuid].value : 32;
						return {
							uuid: descriptor_uuid,
							permission: desc_perm
						};
					});
				}
				service.list.push(characteristic);
			}
			profile_object.list[0].list.push(service);
		}
		return profile_object;
	}

	/**
	 * Quits all interactions with the currently connected BLE device and resets the BLE Master state.
	 * This method performs several actions:
	 * 1. Stops communication with the currently connected device.
	 * 2. Disconnects the connected device if it's still connected.
	 * 3. Deregisters all event callbacks set up for BLE interactions.
	 * 4. Resets the last connected device information and any other relevant state.
	 * 5. Stops any ongoing BLE device scans.
	 * This method is useful for cleanly exiting from BLE interactions, ensuring no lingering connections or callbacks.
	 * @example
	 * ble.quit(); // example: quit interaction with a connected device and clean up
	 */
	quit() { // watching this: might need to bring back the "disconnect all" solution
		try {
			this.#quitInner()
		} catch (e) {
			if (!isPrivateFieldError(e)) throw e
		}
	}

	#quitInner() {
		debugLog(3, "Stopping the BLE Master comms.");
		this.#connection_in_progress = false;
		this.#connection_started_at = 0;
		this.#listener_starting = false;
		this.#prepare_starting = false;

		if (this.#is_scanning) {
			this.stopScan();
		}

		if (!this.#last_connected_mac) {
			debugLog(1, "No device is currently connected to stop interaction with.");
			return;
		}

		const device = this.#devices[this.#last_connected_mac];
		if (device && device.is_connected) {
			this.#disconnectDevice(device);
		}

		// deregister all event callbacks @1.5.2
		if (this.off) {
			this.off.deregisterAll();
		}

		// reset the last connected device and any other relevant state
		this.#last_connected_mac = null;
	}

	#disconnectDevice(device) {
		debugLog(2, "Disconnecting device: " + device.dev_name);

		// turn off all callbacks
		hmBle.mstOffAllCb();

		// check if profile instance exists and destroy it after a delay
		if (device.profile_pid !== undefined) {
			const pid = device.profile_pid;
			hmBle.mstDestroyProfileInstance(pid);
			device.profile_pid = undefined;
			try {
				forgetBlePid(pid);
			} catch (e) {}
		}
		hmBle.mstDisconnect(device.connect_id);
		device.is_connected = false;
	}

	#initiateConnection(dev_addr, response_callback) {
		this.#connection_in_progress = true;
		this.#connection_started_at = Date.now();
		const gen = ++this.#connectGen;

		const dev_addr_ab = mac2ab(dev_addr);

		try {
			hmBle.mstConnect(dev_addr_ab, (a, b, c) => {
				const owned = gen === this.#connectGen;
				try {
					const result = isPlainBleObject(a)
						? a
						: { connected: a, connect_id: b, dev_addr: c }
					let backend_mac = ''
					try {
						if (result.dev_addr != null) backend_mac = ab2mac(result.dev_addr)
					} catch (e) {}
					if (backend_mac && backend_mac !== dev_addr) {
						debugLog(1, `Discrepancy in MAC addresses. Backend MAC: ${backend_mac}, Expected MAC: ${dev_addr}`);
					}
					const connect_id = result.connect_id != null ? result.connect_id : b
					const result_mod = Object.assign({}, result, {
						dev_addr: dev_addr,
						connect_id: connect_id
					});

					if (result_mod.connected === 0) {
						const id = Number(connect_id)
						// Zepp re-fires the last mstConnect callback for later link
						// events. Only the call we just started may become ACL-up.
						if (!owned || !this.#connection_in_progress) {
							response_callback({ connected: false, status: 'stale-connected', raw_id: connect_id });
						} else if (!Number.isFinite(id) || id < 0) {
							response_callback({ connected: false, status: 'no id', raw_id: connect_id });
						} else {
							if (!this.#devices[dev_addr]) {
								this.#devices[dev_addr] = {
									dev_name: "default",
									connect_id: id,
									is_connected: true,
								};
							}
							result_mod.connect_id = id
							this.#handleSuccessfulConnection(result_mod);
							response_callback({ connected: true, status: "connected", connect_id: id });
						}
					} else {
						response_callback({
							connected: false,
							status: result_mod.connected === 1 ? "failed" : "disconnected"
						});
					}
				} catch (e) {
					response_callback({ connected: false, status: "failed" });
				} finally {
					if (owned) {
						this.#connection_in_progress = false;
						this.#connection_started_at = 0;
					}
				}
			});
		} catch (e) {
			this.#connection_in_progress = false;
			this.#connection_started_at = 0;
			response_callback({ connected: false, status: "failed" });
		}
	}

	#handleSuccessfulConnection(result_mod) {
		debugLog(2, `Successful connection to device: ${result_mod.dev_addr}`);
		this.#devices[result_mod.dev_addr] = {
			...this.#devices[result_mod.dev_addr],
			connect_id: result_mod.connect_id,
			is_connected: true
		};
		this.#last_connected_mac = result_mod.dev_addr;
		try {
			setBleConnectId(result_mod.connect_id)
		} catch (e) {}
	}

	#getDevices = () => this.#devices;

	#getCurrentlyConnectedDevice() {  // @add 1.4.8
		return this.#last_connected_mac ? this.#devices[this.#last_connected_mac] : null;
	}

	// === STATIC SETTERS/GETTERS === //

	/**
	 * Sets the debug log level for the BLEMaster class.
	 * @param {number} debug_level - The debug level to set. Possible values:
	 *    `0` - No logs
	 *    `1` - Critical errors only
	 *    `2` - Errors and warnings
	 *    `3` - All logs (including debug information)
	 * @example BLEMaster.SetDebugLevel(3); // show all logs
	*/
	static SetDebugLevel(debug_level) {
		DEBUG_LOG_LEVEL = debug_level;
	}
}

// internal
class QueueManager {
	constructor() {
		this.operation_queue_arr = [];
		this.is_processing = false;
	}

	enqueueOperation(operation) {
		this.operation_queue_arr.push(operation);
		this.processQueue();
	}

	processQueue() {
		if (this.is_processing || this.operation_queue_arr.length === 0) {
			return;
		}

		this.is_processing = true;
		let operation = this.operation_queue_arr.shift();
		operation.execute(() => {
			this.is_processing = false;
			operation = null; // @add 1.5.1
			this.processQueue();
		});
	}

	static #queue_timeout = 5000;
	static #queue_check_interval = 100;
	static _getQueueTimeout() { return this.#queue_timeout; }
	static _getQueueCheckInterval() { return this.#queue_check_interval; }
}

class Write {
	#getCurrentDevice;
	#queueManager;

	constructor(getCurrentDevice, queueManager) {
		this.#getCurrentDevice = getCurrentDevice;
		this.#queueManager = queueManager;
	}

	/**
	 * Writes data to a characteristic of a BLE device. 
	 * This operation is queued to ensure proper synchronization with other BLE operations.
	 * @param {string} uuid - The UUID of the characteristic to write to.
	 * @param {string|ArrayBuffer|Uint8Array} data - The data to write, in various formats.
	 * @param {boolean} [write_without_response=false] - If true, writes without using the queue and without waiting for a response.
	 * @example
	 * // example: write a string to a characteristic
	 * ble.write.characteristic('char_uuid', 'Hello World');
	 * // advanced example: fast write an ArrayBuffer to a characteristic and don't wait for response
	 * const buffer = new Uint8Array([1, 2, 3]).buffer;
	 * ble.write.characteristic('char_uuid', buffer, true);
	 */
	characteristic(uuid, data, write_without_response = false) {
		const operation = {
			execute: (callback) => {
				this.#performCharaWrite(uuid, data, write_without_response, callback);
			}
		};
		this.#queueManager.enqueueOperation(operation);
	}

	/**
	 * Writes data to a descriptor of a device's characteristic. 
	 * This operation is queued to ensure proper synchronization with other BLE operations.
	 * @param {string} chara - The UUID of the characteristic that the descriptor belongs to.
	 * @param {string} desc - The UUID of the descriptor to write to.
	 * @param {string|ArrayBuffer|Uint8Array} data - The data to write. Can be an ArrayBuffer, a Uint8Array, a hex string, or a regular string.
	 * @example
	 * // example: write a hex string to a descriptor
	 * ble.write.descriptor('char_uuid', 'desc_uuid', '0100');
	 * // advanced example: write an ArrayBuffer to a descriptor
	 * const buffer = new Uint8Array([1, 2, 3]).buffer;
	 * ble.write.descriptor('char_uuid', 'desc_uuid', buffer);
	 */
	descriptor(chara, desc, data) {
		const operation = {
			execute: (callback) => {
				this.#performDescriptorWrite(chara, desc, data, callback);
			}
		};
		this.#queueManager.enqueueOperation(operation);
	}

	/**
	 * Enables or disables notifications for a characteristic by writing to the CCCD (Client Characteristic Configuration Descriptor). 
	 * This method also waits for a notification to confirm the enablement or disablement. 
	 * The operation is queued for synchronized execution.
	 * @param {string} chara - The UUID of the characteristic.
	 * @param {boolean} enable - Set to true to enable notifications, false to disable.
	 * @example
	 * // example: toggle notifications for a characteristic (true/false)
	 * ble.write.enableCharaNotifications('char_uuid', true);
	 */
	enableCharaNotifications(chara, enable) {
		const cccd_val = enable ? "0100" : "0000";
		const uuid_cccd = "2902";
		const operation = {
			execute: (callback) => {
				this.#performDescriptorWrite(chara, uuid_cccd, cccd_val, callback);
			}
		};
		this.#queueManager.enqueueOperation(operation);
	}

	/** Let the next queued write run if F001 never reported complete. */
	releaseQueue() {
		try {
			On._setCharaWriteCompleteFlag(true);
			On._setDescWriteCompleteFlag(true);
		} catch (e) {}
	}

	/**
	 * One CCCD write (chara + 2902). Do not spray UUIDs — one ATT at a time.
	 * Returns the raw mstWriteDescriptor result (true/false/0).
	 */
	notifyNow(chara, enable = true) {
		const device = this.#getCurrentDevice();
		if (!device || device.profile_pid === undefined) return 'no pid';
		const data_ab = data2ab(enable ? '0100' : '0000');
		try {
			return hmBle.mstWriteDescriptor(
				device.profile_pid,
				chara,
				'2902',
				data_ab,
				data_ab.byteLength
			);
		} catch (e) {
			return 'throw';
		}
	}

	/** Immediate characteristic write. Bypasses the queue. */
	characteristicNow(uuid, data, write_without_response = false) {
		try {
			On._setCharaWriteCompleteFlag(true);
		} catch (e) {}
		const device = this.#getCurrentDevice();
		if (!device || device.profile_pid === undefined) return false;
		const data_ab = data2ab(data);
		try {
			if (write_without_response) {
				hmBle.mstWriteCharacteristicWithoutResponse(device.profile_pid, uuid, data_ab, data_ab.byteLength);
			} else {
				hmBle.mstWriteCharacteristic(device.profile_pid, uuid, data_ab, data_ab.byteLength);
			}
			return true;
		} catch (e) {
			return false;
		}
	}

	#performCharaWrite(uuid, data, write_without_response, callback) {
		const device = this.#getCurrentDevice();
		if (!device || device.profile_pid === undefined) {
			debugLog(1, ERR.PID_NOT_FOUND);
			callback();
			return;
		}

		const profile_pid = device.profile_pid;
		const data_ab = data2ab(data);

		if (write_without_response) {
			debugLog(3, `EXEC: hmBle.mstWriteCharacteristicWithoutResponse(${profile_pid}, ${uuid}, ${ab2hex(data_ab)}, ${data_ab.byteLength})`); // @upd 1.4.0
			hmBle.mstWriteCharacteristicWithoutResponse(profile_pid, uuid, data_ab, data_ab.byteLength);
			callback();  // since there's no response, immediately invoke the callback. TODO: maybe (?) add a small delay for BLE to finish its stuff
		} else {
			debugLog(3, `EXEC: hmBle.mstWriteCharacteristic(${profile_pid}, ${uuid}, ${ab2hex(data_ab)}, ${data_ab.byteLength})`);
			hmBle.mstWriteCharacteristic(profile_pid, uuid, data_ab, data_ab.byteLength);

			// set up a completion check
			this.#waitForWriteCompletion(callback, "char");
		}
	}

	#performDescriptorWrite(chara, desc, data, callback) {
		const device = this.#getCurrentDevice();
		if (!device || device.profile_pid === undefined) {
			debugLog(1, ERR.PID_NOT_FOUND);
			callback(); // failed operation
			return;
		}

		const profile_pid = device.profile_pid;
		const data_ab = data2ab(data);      // convert data to AB if needed

		debugLog(3, `EXEC: hmBle.mstWriteDescriptor(${profile_pid}, ${chara}, ${desc}, ${ab2hex(data_ab)}, ${data_ab.byteLength})`);
		hmBle.mstWriteDescriptor(profile_pid, chara, desc, data_ab, data_ab.byteLength);

		// desc write queued
		this.#waitForWriteCompletion(callback, "desc");
	}

	#waitForWriteCompletion(callback, operation_type) {
		const check_interval = QueueManager._getQueueCheckInterval();
		const timeout = QueueManager._getQueueTimeout();
		let start_time = Date.now();

		const cb_check_completion = () => {
			if (Date.now() - start_time > timeout) {
				if (operation_type === "char") {
					debugLog(1, ERR.CHAR_WRITE_OPERATION_TIMEOUT);
					callback(ERR.CHAR_WRITE_OPERATION_TIMEOUT);
				} else { // desc
					debugLog(1, ERR.DESC_WRITE_OPERATION_TIMEOUT);
					callback(ERR.DESC_WRITE_OPERATION_TIMEOUT);
				}
				return;
			}

			// check if write operation is complete
			if (On._getDescWriteCompleteFlag() || On._getCharaWriteCompleteFlag()) {
				// reset flags for next operation
				On._setDescWriteCompleteFlag(false);
				On._setCharaWriteCompleteFlag(false);
				callback(); // successful completion
			} else {
				// keep checking
				setTimeout(cb_check_completion, check_interval);
			}
		};

		cb_check_completion();
	}
}

class Read {
	#getCurrentDevice;
	#queueManager;

	constructor(getCurrentDevice, queueManager) {
		this.#getCurrentDevice = getCurrentDevice;
		this.#queueManager = queueManager;
	}

	/**
	 * Reads data from a characteristic of a BLE device. 
	 * This operation is queued to ensure proper synchronization with other BLE operations.
	 * @param {string} uuid - The UUID of the characteristic to read from.
	 * @example
	 * // example: read data from a characteristic
	 * const read = ble.read.characteristic('char_uuid');
	 * if (read.success) console.log('Read successful');
	 * else console.log('Read failed:', read.error);
	 * @returns {Object} An object containing a 'success' property and optionally an 'error' property.
	 */
	characteristic(uuid) {
		const operation = {
			execute: (callback) => {
				this.#performReadOperation(uuid, false, callback);
			}
		};
		this.#queueManager.enqueueOperation(operation);
	}

	/**
	 * Reads data from a descriptor of a characteristic of a BLE device. 
	 * This operation is queued to ensure proper synchronization with other BLE operations.
	 * @param {string} uuid - The UUID of the characteristic.
	 * @param {string} desc - The UUID of the descriptor to read from.
	 * @example
	 * // example: read data from a descriptor
	 * const desc = ble.read.descriptor('char_uuid', 'desc_uuid');
	 * if (desc.success) console.log('Descriptor read successful');
	 * else console.log('Descriptor read failed:', desc.error);
	 * @returns {Object} An object containing a 'success' property and optionally an 'error' property.
	 */
	descriptor(chara, desc) {
		const operation = {
			execute: (callback) => {
				this.#performReadOperation(`${chara}-${desc}`, true, callback);
			}
		};
		this.#queueManager.enqueueOperation(operation);
	}

	#performReadOperation(uuid, is_descriptor, callback) {
		const device = this.#getCurrentDevice();
		if (!device || device.profile_pid === undefined) {
			debugLog(1, ERR.PID_NOT_FOUND);
			callback();
			return;
		}

		const profile_pid = device.profile_pid;

		if (is_descriptor) {
			const [uuid_chara, uuid_desc] = uuid.split('-');
			debugLog(3, `EXEC: hmBle.mstReadDescriptor(${profile_pid}, ${uuid_chara}, ${uuid_desc})`);
			hmBle.mstReadDescriptor(profile_pid, uuid_chara, uuid_desc);
		} else {
			debugLog(3, `EXEC: hmBle.mstReadCharacteristic(${profile_pid}, ${uuid})`);
			hmBle.mstReadCharacteristic(profile_pid, uuid);
		}

		// wait for the completion of this read op
		this.#waitForReadCompletion(is_descriptor, callback);
	}

	#waitForReadCompletion(is_descriptor, callback) {
		const check_interval = QueueManager._getQueueCheckInterval();
		const timeout = QueueManager._getQueueTimeout();
		let start_time = Date.now();

		const cb_check_completion = () => {
			if (Date.now() - start_time > timeout) {
				if (is_descriptor) {
					debugLog(1, ERR.DESC_READ_OPERATION_TIMEOUT);
					callback(ERR.DESC_READ_OPERATION_TIMEOUT);
				} else { // char
					debugLog(1, ERR.CHAR_READ_OPERATION_TIMEOUT);
					callback(ERR.CHAR_READ_OPERATION_TIMEOUT);
				}
				return;
			}
			if ((is_descriptor && On._getDescReadCompleteFlag()) || (!is_descriptor && On._getCharaReadCompleteFlag())) {
				On._setDescReadCompleteFlag(false);
				On._setCharaReadCompleteFlag(false);
				callback(); // ok
			} else {
				setTimeout(cb_check_completion, check_interval);
			}
		};

		cb_check_completion();
	}
}

/**
 * Class to handle BLE event callbacks.
 */
class On {
	#profile_pid;

	constructor(profile_pid) {
		this.#profile_pid = profile_pid;
	}

	setPid(profile_pid) {
		this.#profile_pid = profile_pid;
	}

	/**
	 * Registers a callback for the characteristic read complete event.
	 * This callback is triggered after a read operation on a characteristic is completed.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for characteristic read complete event
	 * ble.on.charaReadComplete((uuid, status) => {
	 *   console.log('Characteristic read complete for UUID:', uuid, 'with status:', status);
	 * });
	 * @receive `uuid` (string) and `status` (number).
	 */
	charaReadComplete(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_charaReadComplete = callback;

		hmBle.mstOnCharaReadComplete((a, b, c) => {
			const { profile, uuid, status } = asBleEvent(a, b, c, null, ['profile', 'uuid', 'status']);
			if (this.#profile_pid == profile || profile == null) {
				On._setCharaReadCompleteFlag(true);
				On.#last_chara_read_status = status;

				if (On._cb_charaReadComplete)
					On._cb_charaReadComplete(uuid, status);
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": charaReadComplete"); // @add 1.5.3
			}
		});
	}

	/**
	 * Registers a callback for the characteristic value arrived event.
	 * This callback is triggered when new data is received from a characteristic.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for characteristic value arrived event
	 * .on.charaValueArrived((uuid, data, length) => {
	 *   console.log('Value arrived for UUID:', uuid, 'Data:', data, 'Length:', length);
	 * });
	 * @receive `uuid` (string), `data` (ArrayBuffer), and `length` (number).
	 */
	charaValueArrived(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_charaValueArrived = callback;

		hmBle.mstOnCharaValueArrived((a, b, c, d) => {
			const { profile, uuid, data, length } = asBleEvent(a, b, c, d, ['profile', 'uuid', 'data', 'length']);
			if (this.#profile_pid == profile || profile == null || data != null) {
				On._setCharaReadCompleteFlag(true);  // make sure we aren't required to sub to charaReadComplete
				On.#last_chara_read_status = 0;

				if (On._cb_charaValueArrived)
					On._cb_charaValueArrived(uuid, data, length);
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": charaValueArrived");
			}
		});
	}

	/**
	 * Registers a callback for the characteristic write complete event.
	 * This callback is triggered after a write operation on a characteristic is completed.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for characteristic write complete event
	 * .on.charaWriteComplete((uuid, status) => {
	 *   console.log('Characteristic write complete for UUID:', uuid, 'Status:', status);
	 * });
	 * @receive `uuid` (string) and `status` (number).
	 */
	charaWriteComplete(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_charaWriteComplete = callback;

		hmBle.mstOnCharaWriteComplete((a, b, c) => {
			const { profile, uuid, status } = asBleEvent(a, b, c, null, ['profile', 'uuid', 'status']);
			if (this.#profile_pid == profile || profile == null || uuid != null) {
				On._setCharaWriteCompleteFlag(true);

				if (On._cb_charaWriteComplete)
					On._cb_charaWriteComplete(uuid, status);
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": charaWriteComplete");
			}
		});
	}

	/**
	 * Registers a callback for the descriptor read complete event.
	 * This callback is triggered after a read operation on a descriptor is completed.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for descriptor read complete event
	 * .on.descReadComplete((chara, desc, status) => {
	 *   console.log(`Descriptor read complete for Characteristic UUID: ${chara}, 
	 *                             Descriptor UUID: ${desc}, Status: ${status}`);
	 * });
	 * @receive `chara` (string) - UUID of the characteristic, `desc` (string) - UUID of the descriptor, `status` (number) - Status of the read operation.
	 */
	descReadComplete(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_descReadComplete = callback;

		hmBle.mstOnDescReadComplete((a, b, c, d) => {
			const { profile, chara, desc, status } = asBleEvent(a, b, c, d, ['profile', 'chara', 'desc', 'status']);

			if (this.#profile_pid == profile || profile == null) {
				On._setDescReadCompleteFlag(true); // set the flag
				On.#last_desc_read_status = status;

				if (On._cb_descReadComplete)
					On._cb_descReadComplete(chara, desc, status);
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": descReadComplete");
			}
		});
	}

	/**
	 * Registers a callback for the descriptor value arrived event.
	 * This callback is triggered when new data arrives at a descriptor.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for descriptor value arrived event
	 * .on.descValueArrived((chara, desc, data, length) => {
	 *   console.log(`Descriptor value arrived for Characteristic UUID: ${chara}, 
	 *              Descriptor UUID: ${desc}, Data: ${data}, Length: ${length}`);
	 * });
	 * @receive `chara` (string) - UUID of the characteristic, `desc` (string) - UUID of the descriptor, `data` (ArrayBuffer) - Data received, `length` (number) - Length of the data.
	 */
	descValueArrived(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_descValueArrived = callback;

		hmBle.mstOnDescValueArrived((a, b, c, d) => {
			const ev = asBleEvent(a, b, c, d, ['profile', 'chara', 'desc', 'data']);
			const { profile, chara, desc, data } = ev;
			const length = ev.length;

			if (this.#profile_pid == profile || profile == null) {
				// set the desc read complete flag to indicate completion of the read operation
				// this way the user can sub either for descReadComplete or descValueArrived
				On._setDescReadCompleteFlag(true); // @add 1.4.7 
				On.#last_desc_read_status = 0;

				if (On._cb_descValueArrived)
					On._cb_descValueArrived(chara, desc, data, length);
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": descValueArrived");
			}
		});
	}

	/**
	 * Registers a callback for the descriptor write complete event.
	 * This callback is triggered after a write operation on a descriptor is completed.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for descriptor write complete event
	 * .on.descWriteComplete((chara, desc, status) => {
	 *   console.log(`Descriptor write complete for Characteristic UUID: ${chara}, 
	 *                              Descriptor UUID: ${desc}, Status: ${status}`);
	 * });
	 * @receive `chara` (string) - UUID of the characteristic, `desc` (string) - UUID of the descriptor, `status` (number) - Status of the write operation.
	 */
	descWriteComplete(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_descWriteComplete = callback;
		// Native hook is BLEMaster.attachDescComplete — do not re-bind here.
	}

	/**
	 * Registers a callback for the characteristic notification event.
	 * This callback is triggered when a notification is received from a characteristic.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for characteristic notification event
	 * .on.charaNotification((uuid, data, length) => {
	 *   console.log(`Notification received for UUID: ${uuid}, Data: ${data}, Length: ${length}`);
	 * });
	 * @receive `uuid` (string) - UUID of the characteristic, `data` (ArrayBuffer) - Notification data, `length` (number) - Length of the data.
	 */
	charaNotification(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_charaNotification = callback;
		// Native hook is BLEMaster.attachNotify — do not re-bind here.
	}

	/**
	 * Registers a callback for the service change begin event.
	 * This callback is triggered when a BLE service change process begins.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for service change begin event
	 * .on.serviceChangeBegin(() => {
	 *   console.log(`Service change has begun`);
	 * });
	 * @receive No parameters.
	 */
	serviceChangeBegin(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_serviceChangeBegin = callback;

		hmBle.mstOnServiceChangeBegin((a) => {
			const { profile } = asBleEvent(a, null, null, null, ['profile']);

			if (this.#profile_pid == profile || profile == null) {
				if (On._cb_serviceChangeBegin)
					On._cb_serviceChangeBegin();
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": serviceChangeBegin");
			}
		});
	}

	/**
	 * Registers a callback for the service change end event.
	 * This callback is triggered when a BLE service change process ends.
	 * @param {Function} callback - The callback to execute on event trigger.
	 * @example
	 * // example: register callback for service change end event
	 * .on.serviceChangeEnd(() => {
	 *   console.log(`Service change has ended`);
	 * });
	 * @receive No parameters.
	 */
	serviceChangeEnd(callback) {
		if (typeof callback !== 'function') {
			debugLog(1, ERR.NOT_A_FUNCTION);
			return;
		}

		On._cb_serviceChangeEnd = callback;

		hmBle.mstOnServiceChangeEnd((a) => {
			const { profile } = asBleEvent(a, null, null, null, ['profile']);

			if (this.#profile_pid == profile || profile == null) {
				if (On._cb_serviceChangeEnd)
					On._cb_serviceChangeEnd();
				else
					debugLog(1, ERR.CB_DEREGISTERED + ": serviceChangeEnd");
			}
		});
	}

	// ===================================================== //
	// === THESE STATICS ARE FOR CORE FUNCTIONALITY ONLY === //
	// ===================================================== //

	// Write flags 
	static #chara_write_complete_flag = false;
	static #desc_write_complete_flag = false;
	static #last_chara_write_status = 0;
	static #last_desc_write_status = 0;

	static _setCharaWriteCompleteFlag(value) { this.#chara_write_complete_flag = value; }
	static _setDescWriteCompleteFlag(value) { this.#desc_write_complete_flag = value; }
	static _getCharaWriteCompleteFlag() { return this.#chara_write_complete_flag; }
	static _getDescWriteCompleteFlag() { return this.#desc_write_complete_flag; }
	static _getLastCharaWriteStatus() { return this.#last_chara_write_status; }
	static _getLastDescWriteStatus() { return this.#last_desc_write_status; }

	// Read flags 
	static #chara_read_complete_flag = false;
	static #last_chara_read_status = 0;
	static #desc_read_complete_flag = false;
	static #last_desc_read_status = 0;

	static _setDescReadCompleteFlag(value) { this.#desc_read_complete_flag = value; }
	static _getDescReadCompleteFlag() { return this.#desc_read_complete_flag; }
	static _getLastDescReadStatus() { return this.#last_desc_read_status; }
	static _setCharaReadCompleteFlag(value) { this.#chara_read_complete_flag = value; }
	static _getCharaReadCompleteFlag() { return this.#chara_read_complete_flag; }
	static _getLastCharaReadStatus() { return this.#last_chara_read_status; }

	// callbacks storage for dereg (no setters/getters. internal use only)
	static _cb_charaReadComplete = null;
	static _cb_charaValueArrived = null;
	static _cb_charaWriteComplete = null;
	static _cb_descReadComplete = null;
	static _cb_descValueArrived = null;
	static _cb_descWriteComplete = null;
	static _cb_charaNotification = null;
	static _cb_serviceChangeBegin = null;
	static _cb_serviceChangeEnd = null;
}

/**
 * Class to handle BLE event callbacks deregistration.
 * This class is used in conjunction with the On class to manage the lifecycle of event callbacks.
 */
class Off {
	/**
	 * Deregisters the callback for characteristic read complete event.
	 * @example
	 * .off.charaReadComplete();
	 */
	charaReadComplete() {
		On._cb_charaReadComplete = null;
	}

	/**
	 * Deregisters the callback for characteristic value arrived event.
	 * @example
	 * .off.charaValueArrived();
	 */
	charaValueArrived() {
		On._cb_charaValueArrived = null;
	}

	/**
	 * Deregisters the callback for characteristic write complete event.
	 * @example
	 * .off.charaWriteComplete();
	 */
	charaWriteComplete() {
		On._cb_charaWriteComplete = null;
	}

	/**
	 * Deregisters the callback for descriptor read complete event.
	 * @example
	 * .off.descReadComplete();
	 */
	descReadComplete() {
		On._cb_descReadComplete = null;
	}

	/**
	 * Deregisters the callback for descriptor value arrived event.
	 * @example
	 * .off.descValueArrived();
	 */
	descValueArrived() {
		On._cb_descValueArrived = null;
	}

	/**
	 * Deregisters the callback for descriptor write complete event.
	 * @example
	 * .off.descWriteComplete();
	 */
	descWriteComplete() {
		On._cb_descWriteComplete = null;
	}

	/**
	 * Deregisters the callback for characteristic notification event.
	 * @example
	 * .off.charaNotification();
	 */
	charaNotification() {
		On._cb_charaNotification = null;
	}

	/**
	 * Deregisters the callback for service change begin event.
	 * @example
	 * .off.serviceChangeBegin();
	 */
	serviceChangeBegin() {
		On._cb_serviceChangeBegin = null;
	}

	/**
	 * Deregisters the callback for service change end event.
	 * @example
	 * .off.serviceChangeEnd();
	 */
	serviceChangeEnd() {
		On._cb_serviceChangeEnd = null;
	}

	/**
	 * Deregisters all callbacks associated with the current BLE connection.
	 * This method to ensures no event callbacks remain active after stopping BLE operations.
	 * @example
	 * .off.deregisterAll();
	 */
	deregisterAll() {
		On._cb_charaReadComplete = null;
		On._cb_charaValueArrived = null;
		On._cb_charaWriteComplete = null;
		On._cb_descReadComplete = null;
		On._cb_descValueArrived = null;
		On._cb_descWriteComplete = null;
		On._cb_charaNotification = null;
		On._cb_serviceChangeBegin = null;
		On._cb_serviceChangeEnd = null;
	}
}

class Get {
	#getDevices;
	#getCurrentDevice;

	constructor(getDevices, getCurrentDevice) {
		this.#getDevices = getDevices;
		this.#getCurrentDevice = getCurrentDevice;
	}

	/**
	 * Retrieves information about all discovered devices.
	 * @example
	 * // example: get all discovered devices
	 * const devices = .get.devices();
	 * console.log('Discovered devices:', JSON.stringify(devices));
	 * @returns {Object} An object containing information about all discovered devices.
	 */
	devices() {
		return this.#getDevices();
	}

	/**
	 * Checks if a specific device is currently connected.
	 * @example
	 * // example: check if a device is connected
	 * const is_connected = .get.isConnected();
	 * console.log('Is device connected:', is_connected);
	 * @returns {boolean} True if the device is connected, false otherwise.
	 */
	isConnected() {
		const device = this.#getCurrentDevice();
		return device && device.is_connected;
	}

	/**
	 * Checks if a device with a specific MAC address has been discovered.
	 * @param {string} dev_addr - The MAC address of the device.
	 * @example
	 * // example: check if a mac has been discovered
	 * const has_mac = .get.hasMAC("1A:2B:3C:4D:5E:6F");
	 * console.log('Has the device been discovered:', has_mac);
	 * @returns {boolean} true if the device has been discovered, false otherwise.
	 */
	hasMAC(dev_addr) { // @upd 1.6.2
		if (!dev_addr) {
			debugLog(1, ERR.DEVICE_ADDR_UNDEFINED);
			return false;
		}

		dev_addr = dev_addr.toLowerCase();

		// check if dev_addr is a pattern
		if (dev_addr.includes('xx')) {
			const matched_dev_addr = findMatchingMacAddress(this.#getDevices(), dev_addr);
			return matched_dev_addr !== null;
		} else {
			// direct check
			return this.#getDevices().hasOwnProperty(dev_addr);
		}
	}

	/**
	 * @deprecated This method is deprecated and will be removed in the future. Please use hasMAC() instead.
	 */
	hasDevice(dev_addr) {
		debugLog(3, ERR.DEPRECATED, "Please use hasMAC() instead.");
		return this.hasMAC(dev_addr);
	}

	/**
	 * Checks if any discovered device has a specific device name.
	 * @param {string} dev_name - The device name to check for.
	 * @example
	 * // example: check if any device has the name "my ble peripheral"
	 * const has_dev_name = .get.hasDeviceName("my ble peripheral");
	 * console.log('Has device name "my ble peripheral":', has_dev_name);
	 * @returns {boolean} true if any device has the specified device name, false otherwise.
	 */
	hasDeviceName(dev_name) { // @add 1.6.3
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.dev_name && device.dev_name.toLowerCase() === dev_name.toLowerCase()
		);
	}

	/**
	 * Checks if any discovered device has a specific service UUID.
	 * @param {string} service_uuid - The UUID of the service to check for.
	 * @example
	 * // example: check if any device has a specific service
	 * const has_service = .get.hasService("1812");
	 * console.log('Has service 1812:', has_service);
	 * @returns {boolean} true if any device has the specified service, false otherwise.
	 */
	hasService(service_uuid) { // @add 1.5.9
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.service_uuid_array && device.service_uuid_array.includes(service_uuid)
		);
	}

	/**
	 * Checks if any discovered device contains specific service data.
	 * @param {string} service_data - The service data to check for.
	 * @example
	 * // example: check if any device contains specific service data
	 * const has_service_data = .get.hasServiceData("somedata");
	 * console.log('Has service data "somedata":', has_service_data);
	 * @returns {boolean} true if any device contains the specified service data, false otherwise.
	 */
	hasServiceData(service_data) {
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.service_data_array && device.service_data_array.some(data =>
				data.service_data.includes(service_data)
			)
		);
	}

	/**
	 * Checks if any discovered device contains a specific service data UUID.
	 * @param {string} uuid - The service data UUID to check for.
	 * @returns {boolean} true if any device contains the specified service data UUID, false otherwise.
	 * @example
	 * // example: Check if any device contains service data with UUID '1337'
	 * const has_sd_uuid = .get.hasServiceDataUUID('1337');
	 * console.log('Has service data UUID 1337:', has_sd_uuid);
	 */
	hasServiceDataUUID(uuid) {
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.service_data_array && device.service_data_array.some(service_data =>
				service_data.uuid === uuid
			)
		);
	}

	/**
	 * Checks if any discovered device has a specific vendor data.
	 * @param {string} vendor_data - The name of the vendor to check for.
	 * @example
	 * // example: check if any device has "zepp" data
	 * const has_vendor_data = .get.hasVendorData("zepp");
	 * console.log('Has vendor "zepp":', has_vendor_data);
	 * @returns {boolean} true if any device is from the specified vendor, false otherwise.
	 */
	hasVendorData(vendor_data) {
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.vendor_data && device.vendor_data.toLowerCase().includes(vendor_data.toLowerCase())
		);
	}

	/**
	 * Checks if any discovered device has a specific vendor ID.
	 * @param {number} vendor_id - The vendor ID to check for.
	 * @returns {boolean} true if any device has the specified vendor ID, false otherwise.
	 * @example
	 * // example: Check if any device has vendor ID 777
	 * const has_vendor_id = .get.hasVendorID(777);
	 * console.log('Has vendor ID 777:', has_vendor_id);
	 */
	hasVendorID(vendor_id) {
		const devices = this.#getDevices();
		return Object.values(devices).some(device =>
			device.vendor_id === vendor_id
		);
	}

	/**
	 * Retrieves the profile pointer ID of a specific device. This is only useful if you need to communicate directly with `hmBle.mst` methods.
	 * @example
	 * // example: get the profile ID of a device
	 * const profile_pid = .get.profilePID();
	 * console.log('Profile pointer ID:', profile_pid);
	 * @returns {number|null} The profile pointer ID of the device if available, null otherwise.
	 */
	profilePID() {
		const device = this.#getCurrentDevice();

		if (!device || !device.is_connected) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return null;
		}

		return device.profile_pid;
	}

	/**
	 * Retrieves the connection ID of a specific device. This is only useful if you need to communicate directly with `hmBle.mst` methods.
	 * @example
	 * // example: get the connection ID of a device
	 * const connection_id = .get.connectionID();
	 * console.log('Connection ID:', connection_id);
	 * @returns {number|null} The connection ID of the device if available, null otherwise.
	 */
	connectionID() {
		const device = this.#getCurrentDevice();

		if (!device || !device.is_connected) {
			debugLog(1, ERR.DEVICE_NOT_CONNECTED);
			return null;
		}

		return device.connect_id;
	}
}

// ===================================================================== //
// ============================== HELPERS ============================== //
// ===================================================================== //

/**
 * Logs the provided parameters to the console if the log's priority meets or exceeds the current DEBUG_LOG_PRIORITY setting.
 * @param {number} level - The priority level of the log message.
 * @param {...any} params - The parameters to be logged.
 */
function debugLog(level, ...params) {
	if (level <= DEBUG_LOG_LEVEL) {
		console.log("[easy-ble]", ...params);
	}
}

/**
 * Converts a string to an ArrayBuffer along with its length.
 * @param {string} str - The string to be converted.
 * @returns {{data_ab: ArrayBuffer, data_len: number}} An object containing the ArrayBuffer and its length.
 */
function str2ab_with_len(str) {
	const data_arr = str.split('').map(char => char.charCodeAt(0));
	return { data_ab: new Uint8Array(data_arr).buffer, data_len: data_arr.length };
}

/**
 * Converts an ArrayBuffer into a MAC address string.
 * @param {ArrayBuffer} ab - The ArrayBuffer to be converted.
 * @returns {string} The MAC address in string format.
 */
function ab2mac(ab) {
	const bytes = new Uint8Array(ab);
	const mac = Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join(':');
	return mac;
}

/**
 * Converts a MAC address string into an ArrayBuffer.
 * @param {string} mac - The MAC address string to be converted.
 * @returns {ArrayBuffer} The corresponding ArrayBuffer.
 */
function mac2ab(mac) {
	return mac2u8(mac).buffer;
}

function mac2u8(mac) {
	const parts = String(mac || '').split(':');
	const u8 = new Uint8Array(6);
	for (let i = 0; i < 6; i++) u8[i] = parseInt(parts[i], 16) || 0;
	return u8;
}

/**
 * Converts an ArrayBuffer to a hexadecimal string representation.
 * @param {ArrayBuffer} buffer - The ArrayBuffer to be converted.
 * @returns {string} The hexadecimal string representation of the ArrayBuffer.
 */
function ab2str_stripped(buffer) { // strip unicode
	return Array.prototype.map.call(new Uint8Array(buffer), u => ('00' + u.toString(16)).slice(-2)).join('');
}

/**
 * Converts various data types to an ArrayBuffer.
 * @param {ArrayBuffer|Uint8Array|string} data - The data to be converted.
 * @returns {ArrayBuffer} The resulting ArrayBuffer.
 */
function data2ab(data) {
	if (data instanceof ArrayBuffer) { // ab = passthrough
		return data;
	} else if (data instanceof Uint8Array) { // uint8_t arr = ab
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	} else if (typeof data === "string") { // @fix 1.2.7
		if (/^[0-9A-Fa-f]+$/.test(data)) {
			const bytes_arr = [];
			for (let i = 0; i < data.length; i += 2) {
				bytes_arr.push(parseInt(data.substring(i, i + 2), 16));
			}
			return new Uint8Array(bytes_arr).buffer;
		} else { // normal string
			return str2ab_with_len(data).data_ab;
		}
	}
}

/**
 * Converts an array of numbers into an ArrayBuffer.
 * @param {number[]} arr - The array of numbers to be converted.
 * @returns {ArrayBuffer} The resulting ArrayBuffer.
 */
export function arr2ab(arr) {
	let buf = new Uint8Array(arr)
	return buf.buffer
}

/**
 * Converts an ArrayBuffer into an array of numbers.
 * @param {ArrayBuffer} arr_buf - The ArrayBuffer to be converted.
 * @returns {number[]} The array of numbers.
 */
export function ab2arr(arr_buf) {
	let array_list = Array.prototype.slice.call(new Uint8Array(arr_buf))
	return array_list
}

/**
 * Converts an array of byte values into a string.
 * @param {number[]} bytes - The array of byte values.
 * @returns {string} The resulting string.
 */
function bytes2str(bytes) {
	return String.fromCharCode(...bytes);
}

/**
 * Validates whether a given string is a valid MAC address.
 * @param {string} mac - The MAC address string to validate.
 * @returns {boolean} true if the string is a valid MAC address, false otherwise.
 */
function isValidMacAddress(mac) {
	const regex = /^[0-9A-Fa-f]{2}([-:])[0-9A-Fa-f]{2}(\1[0-9A-Fa-f]{2}){4}$/;
	return regex.test(mac);
}

/**
 * Finds the first MAC address in a set of devices that matches a given pattern.
 * @param {Object} devices - An object containing MAC addresses as keys.
 * @param {string} pattern - The pattern to match against, where 'xx' can be used as a wildcard for any byte, in the format 'XX:XX:XX:XX:XX:XX'.
 * @returns {string|null} The first MAC address that matches the pattern, or null if no match is found.
 */
function findMatchingMacAddress(devices, pattern) {
	pattern = pattern.toLowerCase();
	for (const mac in devices) {
		if (isMacAddressMatch(mac, pattern)) {
			debugLog(2, "MAC pattern match found:", mac);
			return mac;
		}
	} return null;
}

/**
 * Checks if a MAC address matches a given pattern.
 * The pattern can have 'xx' as a placeholder for any byte value.
 * @param {string} mac - The MAC address to check, in the format 'XX:XX:XX:XX:XX:XX'.
 * @param {string} pattern - The pattern to match against, where 'xx' can be used as a wildcard for any byte, in the format 'XX:XX:XX:XX:XX:XX'.
 * @returns {boolean} True if the MAC address matches the pattern, false otherwise.
 */
function isMacAddressMatch(mac, pattern) {
	const mac_bytes = mac.split(':');
	const pattern_bytes = pattern.split(':');

	if (mac_bytes.length !== pattern_bytes.length) return false;

	for (let i = 0; i < mac_bytes.length; i++) {
		if (pattern_bytes[i] !== 'xx' && pattern_bytes[i] !== mac_bytes[i]) {
			return false;
		}
	} return true;
}

/**
 * Converts an ArrayBuffer to a string of hexadecimal numbers.
 * This function is useful when you need to represent binary data in a readable hexadecimal string format.
 * For example, it can be used to display BLE device addresses or data in a human-readable form.
 * 
 * @param {ArrayBuffer} buffer - The ArrayBuffer to be converted.
 * @param {boolean} [space=false] - Optional parameter to include spaces between hex pairs.
 * @returns {string} The hexadecimal string representation of the ArrayBuffer. Each byte is represented as a two-character hex code.
 * @example
 * // example: convert an ArrayBuffer to a hexadecimal string
 * const buffer = new Uint8Array([10, 20, 30]).buffer;
 * const hexStr = ab2hex(buffer);
 * console.log(hexStr); // output: '0A141E'
 * // advanced example: convert an ArrayBuffer to a hexadecimal string with spaces
 * const buffer = new Uint8Array([10, 20, 30]).buffer;
 * const hex_str = ab2hex(buffer, true);
 * console.log(hex_str); // output: '0A 14 1E'
 */
export function ab2hex(buffer, space = false) { // @add 1.7.8
	const hex_array = Array.prototype.map.call(new Uint8Array(buffer), byte => {
		return ('0' + byte.toString(16)).slice(-2);
	});

	return hex_array.join(space ? ' ' : '').toUpperCase();
}

/**
 * Converts an ArrayBuffer to a number.
 * This function is useful when you need to represent binary data in a readable number format.
 * For example, it can be used to display BLE device battery levels or other data in a human-readable form.
 * 
 * @param {ArrayBuffer} buffer - The ArrayBuffer to be converted.
 * @returns {number} The number representation of the ArrayBuffer.
 * @example
 * // example: convert an ArrayBuffer to a number
 * const buffer = new Uint8Array([81]).buffer;
 * const num = ab2num(buffer);
 * console.log(num); // output: 81
 * // advanced example: convert a multi-byte ArrayBuffer to a number
 * const buffer = new Uint8Array([0x01, 0x02, 0x03]).buffer;
 * const num = ab2num(buffer);
 * console.log(num); // output: 66051
 */
export function ab2num(buffer) { // @fix 1.7.8
	const uint8_arr = new Uint8Array(buffer);
	let num = 0;

	for (let i = 0; i < uint8_arr.length; i++) {
		num = (num << 8) | uint8_arr[i];
	}

	return num;
}

/**
 * Converts an ArrayBuffer into a string.
 * This function is used when you need to convert binary data (ArrayBuffer) into a regular JavaScript string.
 * It's particularly useful for converting data received from BLE devices into text, assuming the data represents text in a compatible encoding (e.g., UTF-8).
 * @param {ArrayBuffer} buffer - The ArrayBuffer to be converted.
 * @example
 * // example: convert an ArrayBuffer to a string
 * const buffer = new Uint8Array([72, 101, 108, 108, 111]).buffer; // 'Hello' in ASCII
 * const str = ab2str(buffer);
 * console.log(str); // output: 'Hello'
 * @returns {string} The resulting string. Note that the output is dependent on the encoding of the byte data in the ArrayBuffer.
 */
export function ab2str(buffer) {
	return String.fromCharCode.apply(null, new Uint8Array(buffer));
}

/**
 * @changelog
 * 1.7.8
 * - @add minification to reduce memory footprint
 * - @upd BLEMaster is no longer a default class, use import { BLEMaster } instead of import BLEMaster
 * - @upd PERMISSIONS collection extracted into easyble-extra.js
 * - @fix (critical) support for multiple services
 * - @fix ab2num(buffer), long numbers support
 * - @fix ab2hex(buffer, space = false), space is now optional
 * - @fix 1.x.x get.devices() -> Convert UUID to hex
 * - @fix tiny documentation fixes
 * - @eol ble.stop() method deprecated, use ble.quit() instead
 * 1.6.9
 * - @fix Read -> descriptor jsdoc
 * - @add function ab2num
 * - @add stop the scan in case it was forgotten or the app crashed during it
 * - @add support for mac patterns "11:XX:33:44:55:66". needed for semi randomized macs
 * - @fix abnormal mac checker TARGET_MAC -> dev_addr
 * - @add new methods to Get class -> hasService(), hasServiceData(), hasVendorData(), hasServiceDataUUID(), hasVendorID()
 * - @fix scan throttler was selfresetting itself
 * - @add duplicates handling. (community contribution) 1.6.1
 * - @upd Get -> hasDevice() moved to hasMac()
 * - @add Get -> hasDeviceName(dev_name)
 * - @upd stop() moved to quit() to avoid confusion with stopScan()
 * - @fix visibility of On callbacks
 * - @fix profile_idp in the docs
 * - @fix get; property + npm = "SyntaxError: invalid property name" now cached. Link to the rescue!
 * - @fix handle unique devices immediately, otherwise duplicates pop
 * - @add warn prefix
 * 1.5.3
 * - @upd abnormal mac address detector log level increase 2 -> 1 (1.3.8)
 * - @upd ab2hexStr() method capitalizes hexadecimals and splits them
 * - @upd better err responses for hmBle.mst write/reads
 * - @add static getters inside QueueManager to manage timeouts and intervals consistently
 * - @upd err code expanded missing att -> missing attribute
 * - @upd removed mac requirement from the most methods as concurrent connections are currently impossible
 * - @rem bugfix for mstDestroyProfileInstance, as the issue was on the peripheral device
 * - @rem callback receiver for notification enabler (CCCD 2902) - static cb_notification_received + whole workaround logic as all desc writes are fixed now and using descWriteComplete.
 * - @add separate desc and chara read/write operations + extended error codes for logs
 * - @add possibility to subscribe to either descReadComplete or descValueArrived for queue to work. same for charas. (1.4.7)
 * - @add getCurrentlyConnectedDevice() alongside the getDevices() getter to reduce memory consumption of the Write & Read sub-classes
 * - @upd Get subclass' creation was moved into the constructor to avoid unnecessary new memory allocations
 * - @add more err codes
 * - @add explicitly dereference the queue operation, allowing garbage collection
 * - @add Off subclass to handle On callbacks deregistration
 * - @upd err table with indicators for when the callbacks were deregistered while user tries to invoke them
 * 1.3.7
 * - @add generateProfileObject method, providing a systematic way to create generic profile objects for devices
 * - @upd ENABLE_DEBUG_LOG changed to DEBUG_LOG_LEVEL; a level-based logging system for more control over logging; levels 1 -> 3
 * - @add error message constants with an ERR_PREFIX for standardized error messaging
 * - @add #connection_in_progress property for better management of connection states
 * - @add introduction of On class with methods for subscribing to supported BLE event callbacks
 * - @add isValidMacAddress function for validating MAC addresses
 * - @add more helper functions for versatile data handling
 * - @upd in Write class, introduction of a write queue and associated processing methods for managing write operations sequentially
 * - @upd improved error handling and logging throughout the library
 * - @add static SetDebugLevel(...) method in BLEMaster class for dynamic control of logging levels
 * - @upd characteristic method in Write class now supports fast writes and comms using write_without_response flag
 * - @add enableCharaNotifications method in Write class to enable or disable notifications for a characteristic
 * - @upd overhaul of the startListener method + startScan throttler
 * - @upd enhancements in error messaging, incorporating new error constants and improving the clarity of error logs
 * - @add additional static methods in On class to manage flags and statuses for write operations
 * - @upd revisions in the Read class methods (characteristic, descriptor) for improved error handling
 * - @upd modifications in the Get class for improved consistency and reliability
 * - @fix disconnect() method was missing a return type when the condition was false
 * - @upd stop() method now can stop all devices or a specific one
 * - @add clean jsdocs with samples
 * - @upd introduction of read queue inside the Read class, including the onValueArrived event
 * - @add possibility to connect to a device without a prior scan (1.2.2)
 * - @add isConnected internal check to avoid multiple connect ions to the same mac (1.2.3)
 * - @add simplified response_callback of the connect() method. returns only connected: true/false (1.2.4)
 * - @upd profile_idp was renamed to profile_pid (profile pointer ID)
 * - @add handle undefined dev_addr case
 * - @fix hexbuf. 1 hex = half a bytes not full byte (1.2.7)
 * - @fix CCCD 2902 write is now properly handled by the queue. waitForWriteCompletion additionally takes a uuid to decide if it's a CCCD (1.2.8)
 * - @add QueManager: a unified queue - now read, write and CCCD requests can be chained together
 * - @upd Read/Write queues refactored to use the queue manager
 * - @add check for abnormal mac to see if this bug is reproduceable
 * - @add CCCD 2902 is now handled outside the enableCharaNotifications in case user writes directly into CCCD desc
 * - @upd err codes pushed into a dict for readability
 * - @add two new methods in the Get subclass - profilePID & connectionID. handy when the user wants to directly talk to hmBle.mst... (1.3.4)
 * - @add BX_CORE_CODES dictionary with human readable error messages
 * - @upd err codes expanded on timeout occurances to tell the user which events exactly they have to subscribe to (charaNotification | charaWriteComplete | charaValueArrived)
 * - @add additional "permissions" param for generateProfileObject(_, _, permissions) method, to allow the user specify custom persmission per each UUID
 * 1.0.0
 * - initial release
 */

/**
 * KNOWN BUGS: 
 * - Tertiary (3rd level) REQUIRES "len2: chara_len" despite docs stating otherwise
 * - Sometimes the backend returns this random mac: 70:53:36:8e:0b:c0 in the (result) object when trying to hmBle.mstConnect
 *   Looks like this MAC is returned when connected status is either 1 or 2 but not 0
 *   SOLUTION: assigning a user provided MAC instead of one returned from the connect object
 * - pair() method doesn't work (?) and might crash the device
 * - Might not support non-standard UUID like 748ad00d-c286-49a7-992e-ccfcdbc12d35 or 1337
 * - After many connections, the watch suddenly doesn't allow another one and just keeps failing
 *     - Connection failed. Max attempts reached.
 *     - Connect result: {"connected":false,"status":"disconnected"}
 *     - EDIT: The watch doesn't stop the scan mode at times. Spamming SCAN_RSP & SCAN_REQ. Disabling BLE or rebooting the watch doesn't help, scan gets latched.
 *   Resetting/Rebooting everything doesn't help. The connection gets latched on the backend (?)
 *   WORKAROUND: 
 *      1) use scan instead of connect / before connect and it should work 
 *      2) or connect to a different BLE device, then you should be able to connect to a previous one.
 * - Backend BUG (?) profile creation doesn't always trigger the mstOnPrepare callback (?)
 */

/**
 * POTENTIAL TODOs:
 * - Support of different CMD Write methods (encrypted comms are currently impossible)
 * - Read/Write Authorization
 *      - required for complex systems
 * - Bonding and Pairing Process
 *      - using pairing PIN and other methods
 * - Handle special cases other than 2902
 *      - 2900: Characteristic Extended Properties
 *      - 2904: Characteristic Presentation Format Descriptor
 *      - 2905: Characteristic Aggregate Format Descriptor
 *      - 2A05: Service Changed Characteristic (should be handled)
 *  - Reliable Write Operations
 *  - Long Chara Values
 *      - due to a relatively small MTU it shoudn't be possible to handle charas bigger than MTU packet
 *  - Queue
 *      - add ability to disable/bypass the queue with a static flag
 *      - add a limiter to avoid queues that are too large
 *  - Devices object
 *      - make sure the object doesn't grow large
 *          - add an ability to reduce it to only active connection
 *          - or timeout devices. but that requires a bit more stored data (date)
 *      - add a limiter to avoid RAM issues
 *  - On each read/write check if attribute is inside the profile
 *          - handled by the backend BX_CORE_MISS_ATT. not much benefit adding it here (?) 
 */
