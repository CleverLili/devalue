const consola = require('consola')
const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const unsafeChars = /[<>\b\f\n\r\t\0\u2028\u2029]/g;
const reserved = /^(?:do|if|in|for|int|let|new|try|var|byte|case|char|else|enum|goto|long|this|void|with|await|break|catch|class|const|final|float|short|super|throw|while|yield|delete|double|export|import|native|return|switch|throws|typeof|boolean|default|extends|finally|package|private|abstract|continue|debugger|function|volatile|interface|protected|transient|implements|instanceof|synchronized)$/;
const escaped: Record<string, string> = {
	'<': '\\u003C',
	'>' : '\\u003E',
	'/': '\\u002F',
	'\\': '\\\\',
	'\b': '\\b',
	'\f': '\\f',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t',
	'\0': '\\0',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};
const objectProtoOwnPropertyNames = Object.getOwnPropertyNames(Object.prototype).sort().join('\0');
// workaround to disable warnings, see https://github.com/nuxt/nuxt.js/issues/4026 for details
const defaultLogLevel = process.env.NUXT_ENV_DEVALUE_LOG_LEVEL || 'warn';
const logLimit = parseInt(process.env.NUXT_ENV_DEVALUE_LOG_LIMIT) || 99;


export default function devalue(value: any, level = defaultLogLevel) {
	const counts = new Map();
	const mapObjToJSON = new Map();

	let logNum = 0;

	function log(message: string) {
		if (logNum < logLimit) {
			consola[level](message);
			logNum+=1
		}
	}


	function walk(thing: any, parent:any, key:string, index:number) {
		if (typeof thing === 'function') {
			consola[level](`Cannot stringify a function ${thing.name}`)
			return
		}

		if (counts.has(thing)) {
			counts.set(thing, counts.get(thing) + 1);
			return;
		}

		counts.set(thing, 1);

		if (!isPrimitive(thing)) {
			const type = getType(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
				case 'Date':
				case 'RegExp':
					return;

				case 'Array':
					thing.forEach((item:any, index:number)=>{walk(item, parent, key, index)});
					break;

				case 'Set':
				case 'Map':
					Array.from(thing).forEach((item, index)=>{walk(item, parent,key, undefined)});
					break;

				default:
					if (thing && thing.toJSON) {
						//remove it from existing counts map so we can come here again to replace.
						counts.delete(thing);

						let json;
						if( mapObjToJSON.has(thing) ){
							json = mapObjToJSON.get(thing);

							//increment the count as it used to do for "thing"
							counts.set(json, counts.get(json) + 1);
						}
						else
						{
							json = thing.toJSON();
							if (getType(json) === 'String') {
								// Try to parse the returned data
								try {
									json = JSON.parse(json);
								}
								catch (e) {
									json = thing;
								}
							}

							//add to map object in case the object is referenced again
							mapObjToJSON.set(thing, json);

							//set the count first time
							counts.set(json, 1)
						}

						if(typeof index !== 'undefined')
							parent[key][index] = json;
						else
							parent[key] = json;
						return;
					}

					const proto = Object.getPrototypeOf(thing);

					if (
						proto !== Object.prototype &&
						proto !== null &&
						Object.getOwnPropertyNames(proto).sort().join('\0') !== objectProtoOwnPropertyNames
					) {
						if (typeof thing.toJSON !== "function") {
							log(`Cannot stringify arbitrary non-POJOs ${thing.constructor.name}`);
						}
					} else if (Object.getOwnPropertySymbols(thing).length > 0) {
						log(`Cannot stringify POJOs with symbolic keys ${Object.getOwnPropertySymbols(thing).map(symbol => symbol.toString())}`);
					} else {
						Object.keys(thing).forEach(function (key) { return walk(thing[key], thing, key, undefined); });
					}

			}
		}
	}

	walk(value, undefined, undefined, undefined);

	const names = new Map();
	Array.from(counts)
		.filter(entry => entry[1] > 1)
		.sort((a, b) => b[1] - a[1])
		.forEach((entry, i) => {
			names.set(entry[0], getName(i));
		});

	function stringify(thing: any): string {
		if (names.has(thing)) {
			return names.get(thing);
		}

		if (isPrimitive(thing)) {
			return stringifyPrimitive(thing);
		}

		const type = getType(thing);

		switch (type) {
			case 'Number':
			case 'String':
			case 'Boolean':
				return `Object(${stringify(thing.valueOf())})`;

			case 'RegExp':
				return thing.toString();

			case 'Date':
				return `new Date(${thing.getTime()})`;

			case 'Array':
				const members = thing.map((v: any, i: number) => i in thing ? stringify(v) : '');
				const tail = thing.length === 0 || (thing.length - 1 in thing) ? '' : ',';
				return `[${members.join(',')}${tail}]`;

			case 'Set':
			case 'Map':
				return `new ${type}([${Array.from(thing).map(stringify).join(',')}])`;

			default:
				if (thing.toJSON) {
					let json = thing.toJSON();
					if (getType(json) === 'String') {
						// Try to parse the returned data
						try {
							json = JSON.parse(json)
						} catch (e) {};
					}
					return stringify(json);
				}
				if (Object.getPrototypeOf(thing) === null) {
					if (Object.keys(thing).length === 0) {
						return 'Object.create(null)';
					}

					return `Object.create(null,{${Object.keys(thing).map(key => `${safeKey(key)}:{writable:true,enumerable:true,value:${stringify(thing[key])}}`).join(',')}})`;
				}

				return `{${Object.keys(thing).map(key => `${safeKey(key)}:${stringify(thing[key])}`).join(',')}}`;
		}
	}

	const str = stringify(value);

	if (names.size) {
		const params: string[] = [];
		const statements: string[] = [];
		const values: string[] = [];

		names.forEach((name, thing) => {
			params.push(name);

			if (isPrimitive(thing)) {
				values.push(stringifyPrimitive(thing));
				return;
			}

			const type = getType(thing);

			switch (type) {
				case 'Number':
				case 'String':
				case 'Boolean':
					values.push(`Object(${stringify(thing.valueOf())})`);
					break;

				case 'RegExp':
					values.push(thing.toString());
					break;

				case 'Date':
					values.push(`new Date(${thing.getTime()})`);
					break;

				case 'Array':
					values.push(`Array(${thing.length})`);
					thing.forEach((v: any, i: number) => {
						statements.push(`${name}[${i}]=${stringify(v)}`);
					});
					break;

				case 'Set':
					values.push(`new Set`);
					statements.push(`${name}.${Array.from(thing).map(v => `add(${stringify(v)})`).join('.')}`);
					break;

				case 'Map':
					values.push(`new Map`);
					statements.push(`${name}.${Array.from(thing).map(([k, v]) => `set(${stringify(k)}, ${stringify(v)})`).join('.')}`);
					break;

				default:
					values.push(Object.getPrototypeOf(thing) === null ? 'Object.create(null)' : '{}');
					Object.keys(thing).forEach(key => {
						statements.push(`${name}${safeProp(key)}=${stringify(thing[key])}`);
					});
			}
		});

		statements.push(`return ${str}`);

		return `(function(${params.join(',')}){${statements.join(';')}}(${values.join(',')}))`
	} else {
		return str;
	}
}

function getName(num: number) {
	let name = '';

	do {
		name = chars[num % chars.length] + name;
		num = ~~(num / chars.length) - 1;
	} while (num >= 0);

	return reserved.test(name) ? `${name}0` : name;
}

function isPrimitive(thing: any) {
	return Object(thing) !== thing;
}

function stringifyPrimitive(thing: any) {
	if (typeof thing === 'string') return stringifyString(thing);
	if (thing === void 0) return 'void 0';
	if (thing === 0 && 1 / thing < 0) return '-0';
	const str = String(thing);
	if (typeof thing === 'number') return str.replace(/^(-)?0\./, '$1.');
	return str;
}

function getType(thing: any) {
	return Object.prototype.toString.call(thing).slice(8, -1);
}

function escapeUnsafeChar(c: string) {
	return escaped[c] || c
}

function escapeUnsafeChars(str: string) {
	return str.replace(unsafeChars, escapeUnsafeChar)
}

function safeKey(key: string) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? key : escapeUnsafeChars(JSON.stringify((key)));
}

function safeProp(key: string) {
	return /^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(key) ? `.${key}` : `[${escapeUnsafeChars(JSON.stringify(key))}]`;
}

function stringifyString(str: string) {
	let result = '"';

	for (let i = 0; i < str.length; i += 1) {
		const char = str.charAt(i);
		const code = char.charCodeAt(0);

		if (char === '"') {
			result += '\\"';
		} else if (char in escaped) {
			result += escaped[char];
		} else if (code >= 0xd800 && code <= 0xdfff) {
			const next = str.charCodeAt(i + 1);

			// If this is the beginning of a [high, low] surrogate pair,
			// add the next two characters, otherwise escape
			if (code <= 0xdbff && (next >= 0xdc00 && next <= 0xdfff)) {
				result += char + str[++i];
			} else {
				result += `\\u${code.toString(16).toUpperCase()}`;
			}
		} else {
			result += char;
		}
	}

	result += '"';
	return result;
}
