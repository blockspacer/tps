#!/usr/bin/env node

const config = require("./config");

const debug = require("debug")("APP");
const multicast = require("./multicast");

const delay = ms => new Promise(res => setTimeout(res, ms))

const app = require("./app.js");
const switches = require('./switches.js');
const cameraService = require('./cameras.js');

const cameras = {};

const sendCmd = async (cmd) => {
    const message = Buffer.from([cmd]);

    await multicast.send(message, 0, message.length, config.MCAST_CAMERA_COMMAND_PORT, config.MCAST_GROUP_ADDR);
};

const send = {
    ping:  () => sendCmd( 0 ),
    shoot: () => sendCmd( 1 )
};

app.post("/api/shoot", async (request, response) => {
    try {
        await send.shoot();
        response.status(204).end();
    } catch(err) {
        response.status(500).send(err);
    }
});

const onMessage = async (message, rinfo) => {
    const address = rinfo.address;
    const mac = message.toString("ascii", 0, 17);

    if(!cameras[mac]) {
        debug(`Found new ${mac} ${address}`);
        cameras[mac] = { address, online:true, lastSeen: Date.now() };
        await cameraService.create({ id: mac, address, mac, online:true });
    } else if(cameras[mac].address != address || !cameras[mac].online) {
        debug(`Recovering ${cameras[mac].interface}:${cameras[mac].port} ${address}`);
        cameras[mac] = { ...cameras[mac], address, online: true };
        await cameraService.patch(mac, { address, online: true });
    }

    cameras[mac].lastSeen = Date.now();
};

const interfaces = require('./interfaces.js');

const ip = require("ip");
const time = require("time-since");

let tplinks = {};

for(let { interface } of config.SWITCHES)
    tplinks[interface] = require("./tplink")();

const addressEnd = (address, end) => ip.toString( [...ip.toBuffer(address).slice(0, 3), end] );

let probeSwitch = async (interface, address) => {

    debug(`Checking switch ${interface} ${address}`);

    await interfaces.upOnly(interface, addressEnd(address, 200));

    return await tplinks[interface].probe(address, {
        timeout: 1*60*1000,
        execTimeout: 1*60*1000
    });
}

let configure = async (interface, desiredAddress, defaultAddress) => {

    debug(`Starting session to configure switch at ${interface}`);

    await retry(5, async () => {
        await tplinks[interface].session(defaultAddress, async device => {
            debug(`Configuring switch at ${interface}`);

            // First get rid of logging messages that mess with the CLI commands execution
            await device.config("no logging monitor|no logging buffer");

            debug("Monitor disabled");

            debug("Configuring spanning tree");

            await device.config("spanning-tree|spanning-tree mode rstp");

            for(let i=0; i<config.SWITCH_PORTS; i++)
                await device.port(i,"spanning-tree|spanning-tree common-config portfast enable");

            debug("Spanning tree configured");

        }, {
            timeout: 2*60*1000,
            execTimeout: 2*60*1000
        });

        debug(`Changing IP address to ${desiredAddress}`);
        await tplinks[interface].changeIpAddress(defaultAddress, 0, desiredAddress, "255.255.255.0");
        debug("IP address changed");

        await interfaces.address(interface, addressEnd( desiredAddress, 200 ));

        await tplinks[interface].session(desiredAddress, async device => {
            debug("Updating startup config");
            await device.privileged("copy running-config startup-config");
            debug("Startup config updated");
        });
    });

    debug("Switch configured");
}

let lastReboot;

let loop = async () => {

    // Get MAC addresses from the switches
    for(let { interface, switchAddress } of config.SWITCHES) {
        await tplinks[interface].session(switchAddress, async device => {

            let table = await device.portMacTable();

            for(let { port, mac } of table)
                if(cameras[mac])
                    if( cameras[mac].interface     != interface     ||
                        cameras[mac].switchAddress != switchAddress ||
                        cameras[mac].port          != port ) {

                        debug(`Linking ${interface}:${port} to ${cameras[mac].address}`);

                        cameras[mac] = { ...cameras[mac], interface, switchAddress, port };
                        await cameraService.patch(mac, { interface, switchAddress, port });
                    }
        });
    }

    let tasks = [];

    for(let mac in cameras) {

        let camera = cameras[mac];

        let notSeen     = !camera.lastSeen   || time.since(camera.lastSeen  ).secs()>10;
        let notRebooted = !camera.lastReboot || time.since(camera.lastReboot).secs()>60;

        if(camera.online && notSeen) {

            debug(`Lost connection to ${camera.interface}:${camera.port} ${camera.address}`);

            camera.online = false;

            tasks.push(
                cameraService.patch(mac, { online: false })
            );
        }

        if(notSeen && notRebooted) {

            // TODO: Power cycle in parallel
            if(camera.interface && camera.switchAddress && camera.port) {

                debug(`Power cycle ${camera.interface}:${camera.port}`);

                tasks.push(
                    tplinks[camera.interface].session(camera.switchAddress, async device => {
                        await device.powerCycle(camera.port, 4000);
                        camera.lastReboot = Date.now();
                    })
                );
            }
        }
    }

    await Promise.all(tasks);

    if(!lastReboot || time.since(lastReboot).secs()>60) {

        let switchTasks = [];

        // get list of all switch ports without detected camera
        for(let {interface, switchAddress} of config.SWITCHES) {
            switchTasks.push(tplinks[interface].session(switchAddress, async device => {

                let tasks = [];

                for(let port=0; port < config.SWITCH_PORTS; port++)
                    if(!Object.values(cameras).find(camera => camera.interface==interface && camera.port==port)) {
                        debug(`Power cycle ${interface}:${port}`);
                        tasks.push(device.powerCycle(port, 4000));
                    }
                await Promise.all(tasks);
            }));
        }

        await Promise.all(switchTasks);
        lastReboot = Date.now();
    }
}

let retry = async (maxRetries, callback) => {

    let lastError = undefined;

    for(let retries=0; retries<maxRetries; retries++) {
        try {
            return await callback();
        } catch(error) {
            lastError = error;
        }
    }

    throw lastError;
};

let configureAllSwitches = async () => {

    for(let { interface, switchAddress } of config.SWITCHES) {
        if(!await probeSwitch(interface, switchAddress)) {

            if(!await probeSwitch(interface, config.SWITCH_DEFAULT_ADDRESS))
                throw `Can't connect to the switch on port ${interface}`;

            await configure(interface, switchAddress, config.SWITCH_DEFAULT_ADDRESS);
        }

        debug(`Found switch ${interface} ${switchAddress}`);
    }

    debug("Enable all network interfaces");

    await Promise.all(config.SWITCHES.map(
        ({ interface, hostAddress }) => interfaces.up(interface, hostAddress)
    ));

    debug("Network interfaces are enabled");
};

let run = async () => {

    try {
        // Prepare network interfaces
        await Promise.all(config.SWITCHES.map(
            ({ interface, hostAddress }) => interfaces.add(interface, hostAddress)
        ));

        await Promise.all(config.SWITCHES.map(
            ({ interface }) => interfaces.up(interface)
        ));

        // Probe and configure all switches
        for(let { interface, switchAddress } of config.SWITCHES)
            if(!await tplinks[interface].probe(switchAddress)) {
                await configureAllSwitches();
                break;
            }

        debug("UDP binding");

        for(let { hostAddress } of config.SWITCHES)
            await multicast.server(config.MCAST_CAMERA_COMMAND_PORT, hostAddress);

        debug("UDP server binded");

        await multicast.client(config.MCAST_CAMERA_REPLY_PORT, config.MCAST_GROUP_ADDR);

        debug("UDP client binded");

        multicast.on("message", onMessage);

        debug("Starting camera heartbeat");

        setInterval(send.ping, 1000);

        /* Give some time to the get ping response from the working cameras */
        await delay(2000);

        debug("Starting main loop");

        while(true)
            await loop();

    } catch(error) {
        console.log("Error:", error);
    }
    debug("Quitting");
}

process.on('unhandledRejection', (reason, promise) => {
    debug('Unhandled rejection at Promise:', promise, 'Reason:', reason);
});

debug("Starting");

/* app.listen() *MUST* be called after all feathers plugins are initialised
 *  * (especialy the authentication ones) to call their setup() methods. */

app.listen(80);

run();