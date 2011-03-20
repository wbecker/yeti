var express = require("express");
var connect = require("connect");
var http = require("http");
var events = require("events");

var sendfiles = require("./sendfiles").sendfiles;
var ui = require("./ui");
var visitor = require("./visitor");
var signal = require("./signal");
var pkg = require("./package");

// Return a random whole number as a string with `Math.random`.
function makeId () {
    return (Math.random() * 0x1000000|0) + "";
}

var emitterRegistry = {}; // by port

var cachebuster = makeId();

// Returns a JSON string of all property-value pairs
// of `keys` in `req`.
function jsonize (req, keys) {
    var o = {};
    keys.forEach(function (k) {
        var v = req.param(k);
        if (v) o[k] = v;
    });
    return JSON.stringify(o);
}

function serveExpress (port, path, cb) {

    // Create an `EventEmitter` for test-related events.
    var tests = new events.EventEmitter;

    var app = express.createServer();

    app.set("views", __dirname + "/views");
    app.set("view engine", "jade");

    // Use our version of Jade.
    app.register(".jade", require("jade"));

    app.get("/", function (req, res) {
        tests.emit("visitor", req.ua);
        var json = jsonize(req, ["transport", "timeout"]);

        res.header("Expires", "0");
        res.header("Pragma", "no-cache");
        res.header("Cache-Control", "no-cache");

        res.render("index", {
            locals : {
                bootstrap : "YETI.start(" + json + ")",
                yeti_version : pkg.readPackageSync().version
            }
        });
    });

    var testIds = {};
    var testResults = {};
    var testQueue = {};

    // Add a new test. Called by the CLI in `app.js`.
    app.put("/tests/add", function (req, res) {
        if (!req.body.tests.length) return res.send(500);

        var urls = [];
        var id = makeId();

        req.body.tests.forEach(function (url) {
            urls.push("/project/" + id + url);
        });
        ui.debug("/tests/add: registered batch", id);

        if (tests.listeners("add").length) {
            tests.emit("add", id, urls);
        } else {
            testQueue[id] = urls;
        }

        res.send(id);
    });

    // Comet middleware.
    // Sends a response when a test comes in.
    function wait (req, responseCallback) {
        function ADDCB (id, urls) {
            ui.debug("/tests/wait: send", urls);
            responseCallback({
                tests : urls
            });
            testIds[id] = 1;
        }

        function SHUTDOWNCB (cb) {
            ui.debug("/tests/wait: shutdown!", port);
            req.on("end", cb);
            // Prevent browsers from reconnecting.
            responseCallback({shutdown:true});
            req.emit("end");
        }

        tests.on("add", ADDCB);
        tests.on("shutdown", SHUTDOWNCB);

        // create a run-once function
        var CLEANUPCB = (function () {
            var once = false;
            return function () {
                if (!once) return;
                once = true;
                // No longer able to write data here.
                tests.removeListener("add", ADDCB);
                tests.removeListener("shutdown", SHUTDOWNCB);
            }
        })();

        // Thanks to IE, we must listen to both.
        // IE sends a RST, other browsers FIN ACK.
        // Just respond to whatever happens sooner.
        req.connection.on("end", CLEANUPCB);
        req.connection.on("close", CLEANUPCB);

        // TODO: Delete stale tests from testQueue?
        if (testQueue) {
            for (
                var id in testQueue
            ) tests.emit("add", id, testQueue[id]);
            testQueue = {};
        }
    }

    // EventSource-powered Comet, called by the browser.
    app.get("/tests/wait", function (req, res) {
        res.writeHead(200, {
            "Content-Type" : "text/event-stream"
        });
        wait(req, function (data) {
            res.write("data: " + JSON.stringify(data) + "\n\n");
        });
    });

    // XMLHttpRequest-powered Comet, called by the browser.
    app.post("/tests/wait", function (req, res) {
        wait(req, function (data) {
            res.send(data);
        });
    });

    // Respond when test results for the given batch ID arrive.
    // Called by the CLI in `app.js`.
    app.get("/status/:id", function (req, res) {
        var id = req.params.id;
        if (id in testIds) {
            if (id in testResults) {
                var results = testResults[id].shift();
                if (results) {
                    return res.send(results);
                } else {
                    // nothing in the queue
                    delete testResults[id];
                    // fallthrough to the test listener
                }
            }
            tests.on(id, function (results) {
                res.send(results);
            });
        } else {
            res.send("Nothing is listening to this batch. At least one browser should be pointed at the Yeti server.", 404);
        }
    });

    // Recieves test results from the browser.
    app.post("/results", function (req, res) {

        var result = JSON.parse(req.body.results);
        result.ua = req.body.useragent;
        var id = req.body.id;

        ui.debug("/results:", id, " has results from: " + result.ua);

        if (id in testIds) {
            if (tests.listeners(id).length) {
                tests.emit(id, result);
            } else {
                if ( ! (id in testResults) ) {
                    testResults[id] = [];
                }
                testResults[id].push(result);
            }
        } else {
            ui.results(result);
        }

        // Advance to the next test immediately.
        // We do this here because determining if an iframe has loaded
        // is much harder on the client side. Takes advantage of the
        // fact that we're on the same domain as the parent page.
        res.send("<script>parent.parent.YETI.next()</script>");

    });

    // #### File Server

    var projectSend = function (res, file, appendString, nocache, prependString) {
        sendfiles.call(
            res,
            [file],
            appendString,
            null, // callback
            {
                prependString : prependString,
                cache : !nocache
            }
        );
    };

    app.get('/project/*', function (req, res) {

        var nocache = false;
        var splat = req.params.pop().split("/");
        if (splat[0] in testIds) {
            splat.shift();
            nocache = true; // using a unique url
        }
        if (splat[0] === "") splat.shift(); // stupid leading slashes
        splat = splat.join("/");

        var file = "/" + decodeURIComponent(splat);

        // The requested file must begin with our cwd.
        if (file.indexOf(path) !== 0) {
            // The file is outside of our cwd.
            // Reject the request.
            ui.log(ui.color.red("[!]")
                + " Rejected " + file
                + ", run in the directory to serve"
                + " or specify --path.");
            return res.send(403);
        }

        if (/^.*\.html?$/.test(req.url)) {
            // Inject a test reporter into the test page.
            projectSend(
                res, file,
                "<script src=\"/dyn/" + cachebuster
                + "/inject.js\"></script><script>"
                + "$yetify({url:\"/results\"});</script>",
                nocache
            );
        } else {
            // Everything else goes untouched.
            projectSend(res, file, "", nocache);
        }

    });

    var incSend = function (res, name, nocache) {
        sendfiles.call(
            res,
            [__dirname + "/../inc/" + name],
            "", // appendString
            null, // callback
            {
                cache : !nocache
            }
        );
    };

    app.get("/inc/*", function (req, res) {
        incSend(res, req.params);
    });

    app.get("/dyn/:cachebuster/*", function (req, res) {
        incSend(res, req.params, true);
    });

    app.get("/favicon.ico", function (req, res) {
        incSend(res, "favicon.ico", true);
    });

    // Start the server.
    // Workaround Express and/or Connect bugs
    // that strip out the `host` and `callback` args.
    // n.b.: Express's `run()` sets up view reloading
    // and sets the `env` to `process.env.ENV`, etc.
    // We are bypassing all of that by using http directly.
    http.Server.prototype.listen.call(app, port, null, cb);

    // Publish the `tests` emitter.
    emitterRegistry[port] = tests;

    return app;

}

// Handle the CLI server start request. Called from `app.js`.
// Starts the server, prints a message and may open browsers as needed.
// Listens for `SIGINT` for client shutdown.
// Called when the server isn't already running.
function fromConfiguration (config) {

    var cb = config.callback;
    cb = cb || null;

    var app = serveExpress(config.port, config.path, cb);

    var baseUrl = "http://" + config.host + ":" + config.port;

    var urls = visitor.composeURLs(
        baseUrl,
        "project" + config.path,
        config.files
    );

    if (urls.length) return visitor.visit(
        config.browsers,
        urls
    );

    signal.listen();

    ui.log("Yeti will only serve files inside " + config.path);
    ui.log("Visit " + ui.color.bold(baseUrl) + ", then run:");
    ui.log("    yeti <test document>");
    ui.log("to run and report the results.");

    if (config.forceVisit) {
        ui.log("Running tests locally with: " + config.browsers.join(", "));

        return visitor.visit(
            config.browsers,
            [baseUrl]
        );
    }

    return app;
}

// Get the cachebuster for unit tests.
exports.getCachebuster = function () {
    return cachebuster;
};

// Get the `tests` emitter for unit tests.
exports.getEmitterForPort = function (port) {
    return emitterRegistry[port];
}

// Get the ports we've used for unit tests.
exports.getPorts = function () {
    return Object.keys(emitterRegistry);
}

exports.fromConfiguration = fromConfiguration;
exports.serve = serveExpress;
