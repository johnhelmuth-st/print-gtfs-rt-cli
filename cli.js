#!/usr/bin/env node
'use strict'

const mri = require('mri')
const {isatty} = require('tty')

const pkg = require('./package.json')

const argv = mri(process.argv.slice(2), {
	boolean: [
		'help', 'h',
		'version', 'v',
		'length-prefixed', 'l',
		'json', 'j',
		'single-json', 's',
		'include-all', 'a',
	]
})

if (argv.help || argv.h) {
	process.stdout.write(`
Usage:
    cat gtfs-rt-feed.pbf | print-gtfs-rt
Options:
    --length-prefixed  -l  Read input as length-prefixed.
                           See https://www.npmjs.com/package/length-prefixed-stream
    --json  -j             Output newline-delimeted JSON (http://ndjson.org).
    --single-json -s       Output a single JSON array.
    --depth            -d  Number of nested levels to print. Default: infinite
    --gtfs-rt-bindings     Path to GTFS-RT bindings. Must be compatible with
                           those generated by protobufjs.
    --include-all -a       Print the entire message, including the FeedMessage.header
                           and FeedMessage.entities in the output. Implies not
                           newline-delimited JSON.
Examples:
    curl 'https://example.org/gtfs-rt.pbf' | print-gtfs-rt
\n`)
	process.exit(0)
}

if (argv.version || argv.v) {
	process.stdout.write(`print-gtfs-rt v${pkg.version}\n`)
	process.exit(0)
}

const showError = (err) => {
	if (!err) return;
	if (err.code === 'EPIPE') return; // todo: refine this
	if (process.env.NODE_ENV === 'dev') console.error(err)
	else console.error(err.message || (err + ''))
	process.exit(1)
}

if (isatty(process.stdin.fd)) showError('You must pipe into print-gtfs-rt.')

const {decode: decodeLengthPrefixed} = require('length-prefixed-stream')
const {pipeline} = require('stream')
const {resolve: pathResolve} = require('path')
const defaultBindings = require('gtfs-rt-bindings')
const {inspect} = require('util')

const read = (readable) => {
	return new Promise((resolve, reject) => {
		const chunks = []
		readable
		.once('error', reject)
		.on('data', chunk => chunks.push(chunk))
		.once('end', () => resolve(chunks))
	})
}

const isLengthPrefixed = argv['length-prefixed'] || argv.l
const includeAll = argv['include-all'] || argv.a
const printAsNDJSON = !includeAll && (argv.json || argv.j)
const printAsJSON = argv['single-json'] || argv.s
const printWithColors = isatty(process.stdout.fd)
const depth = argv.depth || argv.d ? parseInt(argv.depth || argv.d) : null

const bindings = argv['gtfs-rt-bindings']
	? require(pathResolve(process.cwd(), argv['gtfs-rt-bindings']))
	: defaultBindings

const {FeedMessage} = bindings.transit_realtime || bindings
const onFeedMessage = (buf) => {
	const data = FeedMessage.toObject(FeedMessage.decode(buf))
	if (!data) throw new Error('invalid feed')
	if (!data.header) throw new Error('invalid feed: missing header')

	// Protocol buffers don't encode empty arrays, so .entity is missing with 0 FeedEntitys.
	if (!('entity' in data)) {
		data.entity = []
	} else if (!Array.isArray(data.entity)) {
		throw new Error('invalid feed: missing entity[]')
	}

	const inspectOptions = {depth, colors: printWithColors};
	if (includeAll) {
		const msg = printAsJSON ? JSON.stringify(data) : inspect(data, inspectOptions);
		process.stdout.write(msg);
	} else {
		if (printAsJSON) {
			process.stdout.write('[\n')
		}
		for (var i = 0; i < data.entity.length; ++i) {
			const entity = data.entity[i];
			const msg = printAsNDJSON || printAsJSON
				? JSON.stringify(entity)
				: inspect(entity, inspectOptions)
			const isLastEntity = i == data.entity.length - 1;
			const delimeter = (printAsJSON && !isLastEntity) ? ',\n' : '\n'
			process.stdout.write(msg + delimeter)
		}
		if (printAsJSON) {
			process.stdout.write(']\n')
		}
	}
}

if (isLengthPrefixed) {
	const decoder = decodeLengthPrefixed()
	pipeline(
		process.stdin,
		decoder,
		showError,
	)
	decoder.on('data', onFeedMessage)
} else {
	read(process.stdin)
	.then(chunks => onFeedMessage(Buffer.concat(chunks)))
	.catch(showError)
}
process.stdout.on('error', showError)
