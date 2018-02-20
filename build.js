#!/usr/bin/env node

const { readFile, writeFile } = require('fs');
const { dirname, resolve } = require('path');
const md5 = require('md5');

const manifest = require('./manifest.json');

const LAST_DOT = /^(.*\/)?(.*)\.([^\.]*)$/;

const read = file => new Promise((ok, bad) => {
    readFile(file, (err, data) => err ? bad(err) : ok(data));
});

const write = (file, contents) => new Promise((ok, bad) => {
    writeFile(file, contents, err => err ? bad(err) : ok());
});

const mapObj = obj => Promise.all(Object.keys(obj)
    .map(key => ({
        key,
        value: obj[key],
        array: obj[key] instanceof Array,
        type: typeof obj[key]
    }))
    .map(metadata => {
        const { key, value, array, type } = metadata;

        const promise = array ? mapArray(value) :
            type === 'object' ? mapObj(value) :
            Promise.resolve(value);

        return promise
            .then(value => ({ [key]: (value) }));
    }))
    .then(results =>
        results.reduce((prev, curr) => Object.assign(prev, curr), {})
    );

const mapArray = array => Promise.all(
    array.map(
        path => Promise.all([path, read(require.resolve(path))])
    )
)
.then(allContents => allContents.map(
        ([path, contents]) => ({ [path]: insertHash(path, md5(contents)) })
    )
    .reduce((prev, curr) => Object.assign(prev, curr), {})
);

const insertHash = (path, hash) =>
    path.replace(LAST_DOT,
        (match, dir, pre, post) => `${pre}.${hash}.${post}`
    );


/*******************/

const mkdirp = require('mkdirp-promise');
const copy = require('copy-concurrently');

const LAST_SLASH = /^(.*)\\([^\\]*)$/;

const flatten = (obj, prefix) => Object.keys(obj)
    .reduce((arr, key) => {
        const value = obj[key];
        const string = typeof value === 'string';

        if(string){
            return arr.concat({
                dest: prefix ? `${prefix}/${value}` : value, source: key
            });
        }

        const children = flatten(value, prefix ? `${prefix}/${key}` : key);

        return arr.concat(
            children
        );
    }, []);

mkdirp('./dist')
    .then(() => mapObj(manifest))
    .then(hashes => flatten(hashes, './dist'))
    .then(copies => Promise.all(
        [copies].concat(
            copies.map(
                ({ source, dest }) => mkdirp(dirname(dest))
                    .then(() => copyAndUpdateSourcemap({ source, dest })
            )
        )
    )))
    .then(([copies]) => copies)
    .then(copies => copies.reduce(
        (obj, { source, dest }) => Object.assign(obj, { [source]: dest }),
        {}
    ))
    .then(copies =>  write('./dist/manifest.json', JSON.stringify(copies)))
    .then(() => console.log('Build complete'))
    .catch(err => console.error('Error occured', err));


/*********************/

const SOURCEMAP = /^(.*[#@]\s*sourceMappingURL=)(\S+)(.*)$/;
const fs = require('fs');
const es = require('event-stream');

const copySourceMap = ({ source, sourceMap, dest }) => {
    const originalMap = resolve(dirname(require.resolve(source)), sourceMap);
    return read(originalMap)
    .then(md5)
    .then(hash => {
        const newSourceMapFileName = insertHash(sourceMap, hash);
        return copy(
            resolve(dirname(require.resolve(source)), sourceMap),
            resolve(dirname(require.resolve(dest)), newSourceMapFileName)
        )
        .then(() => newSourceMapFileName)
        .catch(err => err.code === 'EEXIST' ?
            sourceMap : Promise.reject(err)
        );
    })
    .catch(err => {
        if(err.code === 'ENOENT' && err.path === originalMap){
            return sourceMap;
        }
        
        throw err;
    });
;}
const copyAndUpdateSourcemap = ({ source, dest }) => mkdirp(dirname(dest))
    .then(() => new Promise((ok, bad) => {
        fs.createReadStream(require.resolve(source))
            .pipe(es.split())
            .pipe(es.map((line, cb) => {
                const [ , pre, sourceMap, post ] = line.match(SOURCEMAP) || [];

                if(pre){
                    copySourceMap({ source, sourceMap, dest })
                        .then(filename => cb(null, `${pre}${filename}${post}`));
                }
                else{
                    cb(null, line);
                }
            }))
            .pipe(es.join('\n'))
            .pipe(fs.createWriteStream(dest))
            .on('close', ok)
            .on('error', bad);
    }));

/*

* Scenario: Prod, Stage, Test, Dev (local)
* Retirement strategy for items from S3
* Could break sourcemaps (investigate rewriting the sourcemap comment)
* Namespacing (implied or configured)
* Deployment (have the "service" be responsible)

* For local dev: run a proxy which builds local devs assets and proxies anything else to configured CDN environment
* You lose the abilty to query the CDN for different historical versions
* Dead man switch for each asset (or use logs)
* Health check? On deployments to verify that every asset we need is there

*/

