import {createRequire as __hooklabCreateRequire} from "node:module";const require=__hooklabCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// sdk/node_modules/.pnpm/bn.js@5.2.5/node_modules/bn.js/lib/bn.js
var require_bn = __commonJS({
  "sdk/node_modules/.pnpm/bn.js@5.2.5/node_modules/bn.js/lib/bn.js"(exports, module) {
    (function(module2, exports2) {
      "use strict";
      function assert(val, msg) {
        if (!val) throw new Error(msg || "Assertion failed");
      }
      function inherits(ctor, superCtor) {
        ctor.super_ = superCtor;
        var TempCtor = function() {
        };
        TempCtor.prototype = superCtor.prototype;
        ctor.prototype = new TempCtor();
        ctor.prototype.constructor = ctor;
      }
      function BN7(number, base, endian) {
        if (BN7.isBN(number)) {
          return number;
        }
        this.negative = 0;
        this.words = null;
        this.length = 0;
        this.red = null;
        if (number !== null) {
          if (base === "le" || base === "be") {
            endian = base;
            base = 10;
          }
          this._init(number || 0, base || 10, endian || "be");
        }
      }
      if (typeof module2 === "object") {
        module2.exports = BN7;
      } else {
        exports2.BN = BN7;
      }
      BN7.BN = BN7;
      BN7.wordSize = 26;
      var Buffer2;
      try {
        if (typeof window !== "undefined" && typeof window.Buffer !== "undefined") {
          Buffer2 = window.Buffer;
        } else {
          Buffer2 = __require("buffer").Buffer;
        }
      } catch (e) {
      }
      BN7.isBN = function isBN(num2) {
        if (num2 instanceof BN7) {
          return true;
        }
        return num2 !== null && typeof num2 === "object" && num2.constructor.wordSize === BN7.wordSize && Array.isArray(num2.words);
      };
      BN7.max = function max(left, right) {
        if (left.cmp(right) > 0) return left;
        return right;
      };
      BN7.min = function min(left, right) {
        if (left.cmp(right) < 0) return left;
        return right;
      };
      BN7.prototype._init = function init(number, base, endian) {
        if (typeof number === "number") {
          return this._initNumber(number, base, endian);
        }
        if (typeof number === "object") {
          return this._initArray(number, base, endian);
        }
        if (base === "hex") {
          base = 16;
        }
        assert(base === (base | 0) && base >= 2 && base <= 36);
        number = number.toString().replace(/\s+/g, "");
        var start = 0;
        if (number[0] === "-") {
          start++;
          this.negative = 1;
        }
        if (start < number.length) {
          if (base === 16) {
            this._parseHex(number, start, endian);
          } else {
            this._parseBase(number, base, start);
            if (endian === "le") {
              this._initArray(this.toArray(), base, endian);
            }
          }
        }
      };
      BN7.prototype._initNumber = function _initNumber(number, base, endian) {
        if (number < 0) {
          this.negative = 1;
          number = -number;
        }
        if (number < 67108864) {
          this.words = [number & 67108863];
          this.length = 1;
        } else if (number < 4503599627370496) {
          this.words = [
            number & 67108863,
            number / 67108864 & 67108863
          ];
          this.length = 2;
        } else {
          assert(number < 9007199254740992);
          this.words = [
            number & 67108863,
            number / 67108864 & 67108863,
            1
          ];
          this.length = 3;
        }
        if (endian !== "le") return;
        this._initArray(this.toArray(), base, endian);
      };
      BN7.prototype._initArray = function _initArray(number, base, endian) {
        assert(typeof number.length === "number");
        if (number.length <= 0) {
          this.words = [0];
          this.length = 1;
          return this;
        }
        this.length = Math.ceil(number.length / 3);
        this.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          this.words[i] = 0;
        }
        var j, w;
        var off = 0;
        if (endian === "be") {
          for (i = number.length - 1, j = 0; i >= 0; i -= 3) {
            w = number[i] | number[i - 1] << 8 | number[i - 2] << 16;
            this.words[j] |= w << off & 67108863;
            this.words[j + 1] = w >>> 26 - off & 67108863;
            off += 24;
            if (off >= 26) {
              off -= 26;
              j++;
            }
          }
        } else if (endian === "le") {
          for (i = 0, j = 0; i < number.length; i += 3) {
            w = number[i] | number[i + 1] << 8 | number[i + 2] << 16;
            this.words[j] |= w << off & 67108863;
            this.words[j + 1] = w >>> 26 - off & 67108863;
            off += 24;
            if (off >= 26) {
              off -= 26;
              j++;
            }
          }
        }
        return this._strip();
      };
      function parseHex4Bits(string, index) {
        var c = string.charCodeAt(index);
        if (c >= 48 && c <= 57) {
          return c - 48;
        } else if (c >= 65 && c <= 70) {
          return c - 55;
        } else if (c >= 97 && c <= 102) {
          return c - 87;
        } else {
          assert(false, "Invalid character in " + string);
        }
      }
      function parseHexByte(string, lowerBound, index) {
        var r = parseHex4Bits(string, index);
        if (index - 1 >= lowerBound) {
          r |= parseHex4Bits(string, index - 1) << 4;
        }
        return r;
      }
      BN7.prototype._parseHex = function _parseHex(number, start, endian) {
        this.length = Math.ceil((number.length - start) / 6);
        this.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          this.words[i] = 0;
        }
        var off = 0;
        var j = 0;
        var w;
        if (endian === "be") {
          for (i = number.length - 1; i >= start; i -= 2) {
            w = parseHexByte(number, start, i) << off;
            this.words[j] |= w & 67108863;
            if (off >= 18) {
              off -= 18;
              j += 1;
              this.words[j] |= w >>> 26;
            } else {
              off += 8;
            }
          }
        } else {
          var parseLength = number.length - start;
          for (i = parseLength % 2 === 0 ? start + 1 : start; i < number.length; i += 2) {
            w = parseHexByte(number, start, i) << off;
            this.words[j] |= w & 67108863;
            if (off >= 18) {
              off -= 18;
              j += 1;
              this.words[j] |= w >>> 26;
            } else {
              off += 8;
            }
          }
        }
        this._strip();
      };
      function parseBase(str, start, end, mul) {
        var r = 0;
        var b = 0;
        var len = Math.min(str.length, end);
        for (var i = start; i < len; i++) {
          var c = str.charCodeAt(i) - 48;
          r *= mul;
          if (c >= 49) {
            b = c - 49 + 10;
          } else if (c >= 17) {
            b = c - 17 + 10;
          } else {
            b = c;
          }
          assert(c >= 0 && b < mul, "Invalid character");
          r += b;
        }
        return r;
      }
      BN7.prototype._parseBase = function _parseBase(number, base, start) {
        this.words = [0];
        this.length = 1;
        for (var limbLen = 0, limbPow = 1; limbPow <= 67108863; limbPow *= base) {
          limbLen++;
        }
        limbLen--;
        limbPow = limbPow / base | 0;
        var total = number.length - start;
        var mod = total % limbLen;
        var end = Math.min(total, total - mod) + start;
        var word = 0;
        for (var i = start; i < end; i += limbLen) {
          word = parseBase(number, i, i + limbLen, base);
          this.imuln(limbPow);
          if (this.words[0] + word < 67108864) {
            this.words[0] += word;
          } else {
            this._iaddn(word);
          }
        }
        if (mod !== 0) {
          var pow = 1;
          word = parseBase(number, i, number.length, base);
          for (i = 0; i < mod; i++) {
            pow *= base;
          }
          this.imuln(pow);
          if (this.words[0] + word < 67108864) {
            this.words[0] += word;
          } else {
            this._iaddn(word);
          }
        }
        this._strip();
      };
      BN7.prototype.copy = function copy(dest) {
        dest.words = new Array(this.length);
        for (var i = 0; i < this.length; i++) {
          dest.words[i] = this.words[i];
        }
        dest.length = this.length;
        dest.negative = this.negative;
        dest.red = this.red;
      };
      function move(dest, src) {
        dest.words = src.words;
        dest.length = src.length;
        dest.negative = src.negative;
        dest.red = src.red;
      }
      BN7.prototype._move = function _move(dest) {
        move(dest, this);
      };
      BN7.prototype.clone = function clone() {
        var r = new BN7(null);
        this.copy(r);
        return r;
      };
      BN7.prototype._expand = function _expand(size) {
        while (this.length < size) {
          this.words[this.length++] = 0;
        }
        return this;
      };
      BN7.prototype._strip = function strip() {
        while (this.length > 1 && this.words[this.length - 1] === 0) {
          this.length--;
        }
        return this._normSign();
      };
      BN7.prototype._normSign = function _normSign() {
        if (this.length === 1 && this.words[0] === 0) {
          this.negative = 0;
        }
        return this;
      };
      if (typeof Symbol !== "undefined" && typeof Symbol.for === "function") {
        try {
          BN7.prototype[Symbol.for("nodejs.util.inspect.custom")] = inspect;
        } catch (e) {
          BN7.prototype.inspect = inspect;
        }
      } else {
        BN7.prototype.inspect = inspect;
      }
      function inspect() {
        return (this.red ? "<BN-R: " : "<BN: ") + this.toString(16) + ">";
      }
      var zeros = [
        "",
        "0",
        "00",
        "000",
        "0000",
        "00000",
        "000000",
        "0000000",
        "00000000",
        "000000000",
        "0000000000",
        "00000000000",
        "000000000000",
        "0000000000000",
        "00000000000000",
        "000000000000000",
        "0000000000000000",
        "00000000000000000",
        "000000000000000000",
        "0000000000000000000",
        "00000000000000000000",
        "000000000000000000000",
        "0000000000000000000000",
        "00000000000000000000000",
        "000000000000000000000000",
        "0000000000000000000000000"
      ];
      var groupSizes = [
        0,
        0,
        25,
        16,
        12,
        11,
        10,
        9,
        8,
        8,
        7,
        7,
        7,
        7,
        6,
        6,
        6,
        6,
        6,
        6,
        6,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5,
        5
      ];
      var groupBases = [
        0,
        0,
        33554432,
        43046721,
        16777216,
        48828125,
        60466176,
        40353607,
        16777216,
        43046721,
        1e7,
        19487171,
        35831808,
        62748517,
        7529536,
        11390625,
        16777216,
        24137569,
        34012224,
        47045881,
        64e6,
        4084101,
        5153632,
        6436343,
        7962624,
        9765625,
        11881376,
        14348907,
        17210368,
        20511149,
        243e5,
        28629151,
        33554432,
        39135393,
        45435424,
        52521875,
        60466176
      ];
      BN7.prototype.toString = function toString(base, padding) {
        base = base || 10;
        padding = padding | 0 || 1;
        var out;
        if (base === 16 || base === "hex") {
          out = "";
          var off = 0;
          var carry = 0;
          for (var i = 0; i < this.length; i++) {
            var w = this.words[i];
            var word = ((w << off | carry) & 16777215).toString(16);
            carry = w >>> 24 - off & 16777215;
            off += 2;
            if (off >= 26) {
              off -= 26;
              i--;
            }
            if (carry !== 0 || i !== this.length - 1) {
              out = zeros[6 - word.length] + word + out;
            } else {
              out = word + out;
            }
          }
          if (carry !== 0) {
            out = carry.toString(16) + out;
          }
          while (out.length % padding !== 0) {
            out = "0" + out;
          }
          if (this.negative !== 0) {
            out = "-" + out;
          }
          return out;
        }
        if (base === (base | 0) && base >= 2 && base <= 36) {
          var groupSize = groupSizes[base];
          var groupBase = groupBases[base];
          out = "";
          var c = this.clone();
          c.negative = 0;
          while (!c.isZero()) {
            var r = c.modrn(groupBase).toString(base);
            c = c.idivn(groupBase);
            if (!c.isZero()) {
              out = zeros[groupSize - r.length] + r + out;
            } else {
              out = r + out;
            }
          }
          if (this.isZero()) {
            out = "0" + out;
          }
          while (out.length % padding !== 0) {
            out = "0" + out;
          }
          if (this.negative !== 0) {
            out = "-" + out;
          }
          return out;
        }
        assert(false, "Base should be between 2 and 36");
      };
      BN7.prototype.toNumber = function toNumber() {
        var ret = this.words[0];
        if (this.length === 2) {
          ret += this.words[1] * 67108864;
        } else if (this.length === 3 && this.words[2] === 1) {
          ret += 4503599627370496 + this.words[1] * 67108864;
        } else if (this.length > 2) {
          assert(false, "Number can only safely store up to 53 bits");
        }
        return this.negative !== 0 ? -ret : ret;
      };
      BN7.prototype.toJSON = function toJSON() {
        return this.toString(16, 2);
      };
      if (Buffer2) {
        BN7.prototype.toBuffer = function toBuffer(endian, length) {
          return this.toArrayLike(Buffer2, endian, length);
        };
      }
      BN7.prototype.toArray = function toArray(endian, length) {
        return this.toArrayLike(Array, endian, length);
      };
      var allocate = function allocate2(ArrayType, size) {
        if (ArrayType.allocUnsafe) {
          return ArrayType.allocUnsafe(size);
        }
        return new ArrayType(size);
      };
      BN7.prototype.toArrayLike = function toArrayLike(ArrayType, endian, length) {
        this._strip();
        var byteLength = this.byteLength();
        var reqLength = length || Math.max(1, byteLength);
        assert(byteLength <= reqLength, "byte array longer than desired length");
        assert(reqLength > 0, "Requested array length <= 0");
        var res = allocate(ArrayType, reqLength);
        var postfix = endian === "le" ? "LE" : "BE";
        this["_toArrayLike" + postfix](res, byteLength);
        return res;
      };
      BN7.prototype._toArrayLikeLE = function _toArrayLikeLE(res, byteLength) {
        var position = 0;
        var carry = 0;
        for (var i = 0, shift = 0; i < this.length; i++) {
          var word = this.words[i] << shift | carry;
          res[position++] = word & 255;
          if (position < res.length) {
            res[position++] = word >> 8 & 255;
          }
          if (position < res.length) {
            res[position++] = word >> 16 & 255;
          }
          if (shift === 6) {
            if (position < res.length) {
              res[position++] = word >> 24 & 255;
            }
            carry = 0;
            shift = 0;
          } else {
            carry = word >>> 24;
            shift += 2;
          }
        }
        if (position < res.length) {
          res[position++] = carry;
          while (position < res.length) {
            res[position++] = 0;
          }
        }
      };
      BN7.prototype._toArrayLikeBE = function _toArrayLikeBE(res, byteLength) {
        var position = res.length - 1;
        var carry = 0;
        for (var i = 0, shift = 0; i < this.length; i++) {
          var word = this.words[i] << shift | carry;
          res[position--] = word & 255;
          if (position >= 0) {
            res[position--] = word >> 8 & 255;
          }
          if (position >= 0) {
            res[position--] = word >> 16 & 255;
          }
          if (shift === 6) {
            if (position >= 0) {
              res[position--] = word >> 24 & 255;
            }
            carry = 0;
            shift = 0;
          } else {
            carry = word >>> 24;
            shift += 2;
          }
        }
        if (position >= 0) {
          res[position--] = carry;
          while (position >= 0) {
            res[position--] = 0;
          }
        }
      };
      if (Math.clz32) {
        BN7.prototype._countBits = function _countBits(w) {
          return 32 - Math.clz32(w);
        };
      } else {
        BN7.prototype._countBits = function _countBits(w) {
          var t = w;
          var r = 0;
          if (t >= 4096) {
            r += 13;
            t >>>= 13;
          }
          if (t >= 64) {
            r += 7;
            t >>>= 7;
          }
          if (t >= 8) {
            r += 4;
            t >>>= 4;
          }
          if (t >= 2) {
            r += 2;
            t >>>= 2;
          }
          return r + t;
        };
      }
      BN7.prototype._zeroBits = function _zeroBits(w) {
        if (w === 0) return 26;
        var t = w;
        var r = 0;
        if ((t & 8191) === 0) {
          r += 13;
          t >>>= 13;
        }
        if ((t & 127) === 0) {
          r += 7;
          t >>>= 7;
        }
        if ((t & 15) === 0) {
          r += 4;
          t >>>= 4;
        }
        if ((t & 3) === 0) {
          r += 2;
          t >>>= 2;
        }
        if ((t & 1) === 0) {
          r++;
        }
        return r;
      };
      BN7.prototype.bitLength = function bitLength() {
        var w = this.words[this.length - 1];
        var hi = this._countBits(w);
        return (this.length - 1) * 26 + hi;
      };
      function toBitArray(num2) {
        var w = new Array(num2.bitLength());
        for (var bit = 0; bit < w.length; bit++) {
          var off = bit / 26 | 0;
          var wbit = bit % 26;
          w[bit] = num2.words[off] >>> wbit & 1;
        }
        return w;
      }
      BN7.prototype.zeroBits = function zeroBits() {
        if (this.isZero()) return 0;
        var r = 0;
        for (var i = 0; i < this.length; i++) {
          var b = this._zeroBits(this.words[i]);
          r += b;
          if (b !== 26) break;
        }
        return r;
      };
      BN7.prototype.byteLength = function byteLength() {
        return Math.ceil(this.bitLength() / 8);
      };
      BN7.prototype.toTwos = function toTwos(width) {
        if (this.negative !== 0) {
          return this.abs().inotn(width).iaddn(1);
        }
        return this.clone();
      };
      BN7.prototype.fromTwos = function fromTwos(width) {
        if (this.testn(width - 1)) {
          return this.notn(width).iaddn(1).ineg();
        }
        return this.clone();
      };
      BN7.prototype.isNeg = function isNeg() {
        return this.negative !== 0;
      };
      BN7.prototype.neg = function neg() {
        return this.clone().ineg();
      };
      BN7.prototype.ineg = function ineg() {
        if (!this.isZero()) {
          this.negative ^= 1;
        }
        return this;
      };
      BN7.prototype.iuor = function iuor(num2) {
        while (this.length < num2.length) {
          this.words[this.length++] = 0;
        }
        for (var i = 0; i < num2.length; i++) {
          this.words[i] = this.words[i] | num2.words[i];
        }
        return this._strip();
      };
      BN7.prototype.ior = function ior(num2) {
        assert((this.negative | num2.negative) === 0);
        return this.iuor(num2);
      };
      BN7.prototype.or = function or(num2) {
        if (this.length > num2.length) return this.clone().ior(num2);
        return num2.clone().ior(this);
      };
      BN7.prototype.uor = function uor(num2) {
        if (this.length > num2.length) return this.clone().iuor(num2);
        return num2.clone().iuor(this);
      };
      BN7.prototype.iuand = function iuand(num2) {
        var b;
        if (this.length > num2.length) {
          b = num2;
        } else {
          b = this;
        }
        for (var i = 0; i < b.length; i++) {
          this.words[i] = this.words[i] & num2.words[i];
        }
        this.length = b.length;
        return this._strip();
      };
      BN7.prototype.iand = function iand(num2) {
        assert((this.negative | num2.negative) === 0);
        return this.iuand(num2);
      };
      BN7.prototype.and = function and(num2) {
        if (this.length > num2.length) return this.clone().iand(num2);
        return num2.clone().iand(this);
      };
      BN7.prototype.uand = function uand(num2) {
        if (this.length > num2.length) return this.clone().iuand(num2);
        return num2.clone().iuand(this);
      };
      BN7.prototype.iuxor = function iuxor(num2) {
        var a;
        var b;
        if (this.length > num2.length) {
          a = this;
          b = num2;
        } else {
          a = num2;
          b = this;
        }
        for (var i = 0; i < b.length; i++) {
          this.words[i] = a.words[i] ^ b.words[i];
        }
        if (this !== a) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        this.length = a.length;
        return this._strip();
      };
      BN7.prototype.ixor = function ixor(num2) {
        assert((this.negative | num2.negative) === 0);
        return this.iuxor(num2);
      };
      BN7.prototype.xor = function xor(num2) {
        if (this.length > num2.length) return this.clone().ixor(num2);
        return num2.clone().ixor(this);
      };
      BN7.prototype.uxor = function uxor(num2) {
        if (this.length > num2.length) return this.clone().iuxor(num2);
        return num2.clone().iuxor(this);
      };
      BN7.prototype.inotn = function inotn(width) {
        assert(typeof width === "number" && width >= 0);
        var bytesNeeded = Math.ceil(width / 26) | 0;
        var bitsLeft = width % 26;
        this._expand(bytesNeeded);
        if (bitsLeft > 0) {
          bytesNeeded--;
        }
        for (var i = 0; i < bytesNeeded; i++) {
          this.words[i] = ~this.words[i] & 67108863;
        }
        if (bitsLeft > 0) {
          this.words[i] = ~this.words[i] & 67108863 >> 26 - bitsLeft;
          i++;
        }
        for (; i < this.length; i++) {
          this.words[i] = 0;
        }
        return this._strip();
      };
      BN7.prototype.notn = function notn(width) {
        return this.clone().inotn(width);
      };
      BN7.prototype.setn = function setn(bit, val) {
        assert(typeof bit === "number" && bit >= 0);
        var off = bit / 26 | 0;
        var wbit = bit % 26;
        this._expand(off + 1);
        if (val) {
          this.words[off] = this.words[off] | 1 << wbit;
        } else {
          this.words[off] = this.words[off] & ~(1 << wbit);
        }
        return this._strip();
      };
      BN7.prototype.iadd = function iadd(num2) {
        var r;
        if (this.negative !== 0 && num2.negative === 0) {
          this.negative = 0;
          r = this.isub(num2);
          this.negative ^= 1;
          return this._normSign();
        } else if (this.negative === 0 && num2.negative !== 0) {
          num2.negative = 0;
          r = this.isub(num2);
          num2.negative = 1;
          return r._normSign();
        }
        var a, b;
        if (this.length > num2.length) {
          a = this;
          b = num2;
        } else {
          a = num2;
          b = this;
        }
        var carry = 0;
        for (var i = 0; i < b.length; i++) {
          r = (a.words[i] | 0) + (b.words[i] | 0) + carry;
          this.words[i] = r & 67108863;
          carry = r >>> 26;
        }
        for (; carry !== 0 && i < a.length; i++) {
          r = (a.words[i] | 0) + carry;
          this.words[i] = r & 67108863;
          carry = r >>> 26;
        }
        this.length = a.length;
        if (carry !== 0) {
          this.words[this.length] = carry;
          this.length++;
        } else if (a !== this) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        return this;
      };
      BN7.prototype.add = function add(num2) {
        var res;
        if (num2.negative !== 0 && this.negative === 0) {
          num2.negative = 0;
          res = this.sub(num2);
          num2.negative ^= 1;
          return res;
        } else if (num2.negative === 0 && this.negative !== 0) {
          this.negative = 0;
          res = num2.sub(this);
          this.negative = 1;
          return res;
        }
        if (this.length > num2.length) return this.clone().iadd(num2);
        return num2.clone().iadd(this);
      };
      BN7.prototype.isub = function isub(num2) {
        if (num2.negative !== 0) {
          num2.negative = 0;
          var r = this.iadd(num2);
          num2.negative = 1;
          return r._normSign();
        } else if (this.negative !== 0) {
          this.negative = 0;
          this.iadd(num2);
          this.negative = 1;
          return this._normSign();
        }
        var cmp = this.cmp(num2);
        if (cmp === 0) {
          this.negative = 0;
          this.length = 1;
          this.words[0] = 0;
          return this;
        }
        var a, b;
        if (cmp > 0) {
          a = this;
          b = num2;
        } else {
          a = num2;
          b = this;
        }
        var carry = 0;
        for (var i = 0; i < b.length; i++) {
          r = (a.words[i] | 0) - (b.words[i] | 0) + carry;
          carry = r >> 26;
          this.words[i] = r & 67108863;
        }
        for (; carry !== 0 && i < a.length; i++) {
          r = (a.words[i] | 0) + carry;
          carry = r >> 26;
          this.words[i] = r & 67108863;
        }
        if (carry === 0 && i < a.length && a !== this) {
          for (; i < a.length; i++) {
            this.words[i] = a.words[i];
          }
        }
        this.length = Math.max(this.length, i);
        if (a !== this) {
          this.negative = 1;
        }
        return this._strip();
      };
      BN7.prototype.sub = function sub(num2) {
        return this.clone().isub(num2);
      };
      function smallMulTo(self, num2, out) {
        out.negative = num2.negative ^ self.negative;
        var len = self.length + num2.length | 0;
        out.length = len;
        len = len - 1 | 0;
        var a = self.words[0] | 0;
        var b = num2.words[0] | 0;
        var r = a * b;
        var lo = r & 67108863;
        var carry = r / 67108864 | 0;
        out.words[0] = lo;
        for (var k = 1; k < len; k++) {
          var ncarry = carry >>> 26;
          var rword = carry & 67108863;
          var maxJ = Math.min(k, num2.length - 1);
          for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
            var i = k - j | 0;
            a = self.words[i] | 0;
            b = num2.words[j] | 0;
            r = a * b + rword;
            ncarry += r / 67108864 | 0;
            rword = r & 67108863;
          }
          out.words[k] = rword | 0;
          carry = ncarry | 0;
        }
        if (carry !== 0) {
          out.words[k] = carry | 0;
        } else {
          out.length--;
        }
        return out._strip();
      }
      var comb10MulTo = function comb10MulTo2(self, num2, out) {
        var a = self.words;
        var b = num2.words;
        var o = out.words;
        var c = 0;
        var lo;
        var mid;
        var hi;
        var a0 = a[0] | 0;
        var al0 = a0 & 8191;
        var ah0 = a0 >>> 13;
        var a1 = a[1] | 0;
        var al1 = a1 & 8191;
        var ah1 = a1 >>> 13;
        var a2 = a[2] | 0;
        var al2 = a2 & 8191;
        var ah2 = a2 >>> 13;
        var a3 = a[3] | 0;
        var al3 = a3 & 8191;
        var ah3 = a3 >>> 13;
        var a4 = a[4] | 0;
        var al4 = a4 & 8191;
        var ah4 = a4 >>> 13;
        var a5 = a[5] | 0;
        var al5 = a5 & 8191;
        var ah5 = a5 >>> 13;
        var a6 = a[6] | 0;
        var al6 = a6 & 8191;
        var ah6 = a6 >>> 13;
        var a7 = a[7] | 0;
        var al7 = a7 & 8191;
        var ah7 = a7 >>> 13;
        var a8 = a[8] | 0;
        var al8 = a8 & 8191;
        var ah8 = a8 >>> 13;
        var a9 = a[9] | 0;
        var al9 = a9 & 8191;
        var ah9 = a9 >>> 13;
        var b0 = b[0] | 0;
        var bl0 = b0 & 8191;
        var bh0 = b0 >>> 13;
        var b1 = b[1] | 0;
        var bl1 = b1 & 8191;
        var bh1 = b1 >>> 13;
        var b2 = b[2] | 0;
        var bl2 = b2 & 8191;
        var bh2 = b2 >>> 13;
        var b3 = b[3] | 0;
        var bl3 = b3 & 8191;
        var bh3 = b3 >>> 13;
        var b4 = b[4] | 0;
        var bl4 = b4 & 8191;
        var bh4 = b4 >>> 13;
        var b5 = b[5] | 0;
        var bl5 = b5 & 8191;
        var bh5 = b5 >>> 13;
        var b6 = b[6] | 0;
        var bl6 = b6 & 8191;
        var bh6 = b6 >>> 13;
        var b7 = b[7] | 0;
        var bl7 = b7 & 8191;
        var bh7 = b7 >>> 13;
        var b8 = b[8] | 0;
        var bl8 = b8 & 8191;
        var bh8 = b8 >>> 13;
        var b9 = b[9] | 0;
        var bl9 = b9 & 8191;
        var bh9 = b9 >>> 13;
        out.negative = self.negative ^ num2.negative;
        out.length = 19;
        lo = Math.imul(al0, bl0);
        mid = Math.imul(al0, bh0);
        mid = mid + Math.imul(ah0, bl0) | 0;
        hi = Math.imul(ah0, bh0);
        var w0 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w0 >>> 26) | 0;
        w0 &= 67108863;
        lo = Math.imul(al1, bl0);
        mid = Math.imul(al1, bh0);
        mid = mid + Math.imul(ah1, bl0) | 0;
        hi = Math.imul(ah1, bh0);
        lo = lo + Math.imul(al0, bl1) | 0;
        mid = mid + Math.imul(al0, bh1) | 0;
        mid = mid + Math.imul(ah0, bl1) | 0;
        hi = hi + Math.imul(ah0, bh1) | 0;
        var w1 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w1 >>> 26) | 0;
        w1 &= 67108863;
        lo = Math.imul(al2, bl0);
        mid = Math.imul(al2, bh0);
        mid = mid + Math.imul(ah2, bl0) | 0;
        hi = Math.imul(ah2, bh0);
        lo = lo + Math.imul(al1, bl1) | 0;
        mid = mid + Math.imul(al1, bh1) | 0;
        mid = mid + Math.imul(ah1, bl1) | 0;
        hi = hi + Math.imul(ah1, bh1) | 0;
        lo = lo + Math.imul(al0, bl2) | 0;
        mid = mid + Math.imul(al0, bh2) | 0;
        mid = mid + Math.imul(ah0, bl2) | 0;
        hi = hi + Math.imul(ah0, bh2) | 0;
        var w2 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w2 >>> 26) | 0;
        w2 &= 67108863;
        lo = Math.imul(al3, bl0);
        mid = Math.imul(al3, bh0);
        mid = mid + Math.imul(ah3, bl0) | 0;
        hi = Math.imul(ah3, bh0);
        lo = lo + Math.imul(al2, bl1) | 0;
        mid = mid + Math.imul(al2, bh1) | 0;
        mid = mid + Math.imul(ah2, bl1) | 0;
        hi = hi + Math.imul(ah2, bh1) | 0;
        lo = lo + Math.imul(al1, bl2) | 0;
        mid = mid + Math.imul(al1, bh2) | 0;
        mid = mid + Math.imul(ah1, bl2) | 0;
        hi = hi + Math.imul(ah1, bh2) | 0;
        lo = lo + Math.imul(al0, bl3) | 0;
        mid = mid + Math.imul(al0, bh3) | 0;
        mid = mid + Math.imul(ah0, bl3) | 0;
        hi = hi + Math.imul(ah0, bh3) | 0;
        var w3 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w3 >>> 26) | 0;
        w3 &= 67108863;
        lo = Math.imul(al4, bl0);
        mid = Math.imul(al4, bh0);
        mid = mid + Math.imul(ah4, bl0) | 0;
        hi = Math.imul(ah4, bh0);
        lo = lo + Math.imul(al3, bl1) | 0;
        mid = mid + Math.imul(al3, bh1) | 0;
        mid = mid + Math.imul(ah3, bl1) | 0;
        hi = hi + Math.imul(ah3, bh1) | 0;
        lo = lo + Math.imul(al2, bl2) | 0;
        mid = mid + Math.imul(al2, bh2) | 0;
        mid = mid + Math.imul(ah2, bl2) | 0;
        hi = hi + Math.imul(ah2, bh2) | 0;
        lo = lo + Math.imul(al1, bl3) | 0;
        mid = mid + Math.imul(al1, bh3) | 0;
        mid = mid + Math.imul(ah1, bl3) | 0;
        hi = hi + Math.imul(ah1, bh3) | 0;
        lo = lo + Math.imul(al0, bl4) | 0;
        mid = mid + Math.imul(al0, bh4) | 0;
        mid = mid + Math.imul(ah0, bl4) | 0;
        hi = hi + Math.imul(ah0, bh4) | 0;
        var w4 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w4 >>> 26) | 0;
        w4 &= 67108863;
        lo = Math.imul(al5, bl0);
        mid = Math.imul(al5, bh0);
        mid = mid + Math.imul(ah5, bl0) | 0;
        hi = Math.imul(ah5, bh0);
        lo = lo + Math.imul(al4, bl1) | 0;
        mid = mid + Math.imul(al4, bh1) | 0;
        mid = mid + Math.imul(ah4, bl1) | 0;
        hi = hi + Math.imul(ah4, bh1) | 0;
        lo = lo + Math.imul(al3, bl2) | 0;
        mid = mid + Math.imul(al3, bh2) | 0;
        mid = mid + Math.imul(ah3, bl2) | 0;
        hi = hi + Math.imul(ah3, bh2) | 0;
        lo = lo + Math.imul(al2, bl3) | 0;
        mid = mid + Math.imul(al2, bh3) | 0;
        mid = mid + Math.imul(ah2, bl3) | 0;
        hi = hi + Math.imul(ah2, bh3) | 0;
        lo = lo + Math.imul(al1, bl4) | 0;
        mid = mid + Math.imul(al1, bh4) | 0;
        mid = mid + Math.imul(ah1, bl4) | 0;
        hi = hi + Math.imul(ah1, bh4) | 0;
        lo = lo + Math.imul(al0, bl5) | 0;
        mid = mid + Math.imul(al0, bh5) | 0;
        mid = mid + Math.imul(ah0, bl5) | 0;
        hi = hi + Math.imul(ah0, bh5) | 0;
        var w5 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w5 >>> 26) | 0;
        w5 &= 67108863;
        lo = Math.imul(al6, bl0);
        mid = Math.imul(al6, bh0);
        mid = mid + Math.imul(ah6, bl0) | 0;
        hi = Math.imul(ah6, bh0);
        lo = lo + Math.imul(al5, bl1) | 0;
        mid = mid + Math.imul(al5, bh1) | 0;
        mid = mid + Math.imul(ah5, bl1) | 0;
        hi = hi + Math.imul(ah5, bh1) | 0;
        lo = lo + Math.imul(al4, bl2) | 0;
        mid = mid + Math.imul(al4, bh2) | 0;
        mid = mid + Math.imul(ah4, bl2) | 0;
        hi = hi + Math.imul(ah4, bh2) | 0;
        lo = lo + Math.imul(al3, bl3) | 0;
        mid = mid + Math.imul(al3, bh3) | 0;
        mid = mid + Math.imul(ah3, bl3) | 0;
        hi = hi + Math.imul(ah3, bh3) | 0;
        lo = lo + Math.imul(al2, bl4) | 0;
        mid = mid + Math.imul(al2, bh4) | 0;
        mid = mid + Math.imul(ah2, bl4) | 0;
        hi = hi + Math.imul(ah2, bh4) | 0;
        lo = lo + Math.imul(al1, bl5) | 0;
        mid = mid + Math.imul(al1, bh5) | 0;
        mid = mid + Math.imul(ah1, bl5) | 0;
        hi = hi + Math.imul(ah1, bh5) | 0;
        lo = lo + Math.imul(al0, bl6) | 0;
        mid = mid + Math.imul(al0, bh6) | 0;
        mid = mid + Math.imul(ah0, bl6) | 0;
        hi = hi + Math.imul(ah0, bh6) | 0;
        var w6 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w6 >>> 26) | 0;
        w6 &= 67108863;
        lo = Math.imul(al7, bl0);
        mid = Math.imul(al7, bh0);
        mid = mid + Math.imul(ah7, bl0) | 0;
        hi = Math.imul(ah7, bh0);
        lo = lo + Math.imul(al6, bl1) | 0;
        mid = mid + Math.imul(al6, bh1) | 0;
        mid = mid + Math.imul(ah6, bl1) | 0;
        hi = hi + Math.imul(ah6, bh1) | 0;
        lo = lo + Math.imul(al5, bl2) | 0;
        mid = mid + Math.imul(al5, bh2) | 0;
        mid = mid + Math.imul(ah5, bl2) | 0;
        hi = hi + Math.imul(ah5, bh2) | 0;
        lo = lo + Math.imul(al4, bl3) | 0;
        mid = mid + Math.imul(al4, bh3) | 0;
        mid = mid + Math.imul(ah4, bl3) | 0;
        hi = hi + Math.imul(ah4, bh3) | 0;
        lo = lo + Math.imul(al3, bl4) | 0;
        mid = mid + Math.imul(al3, bh4) | 0;
        mid = mid + Math.imul(ah3, bl4) | 0;
        hi = hi + Math.imul(ah3, bh4) | 0;
        lo = lo + Math.imul(al2, bl5) | 0;
        mid = mid + Math.imul(al2, bh5) | 0;
        mid = mid + Math.imul(ah2, bl5) | 0;
        hi = hi + Math.imul(ah2, bh5) | 0;
        lo = lo + Math.imul(al1, bl6) | 0;
        mid = mid + Math.imul(al1, bh6) | 0;
        mid = mid + Math.imul(ah1, bl6) | 0;
        hi = hi + Math.imul(ah1, bh6) | 0;
        lo = lo + Math.imul(al0, bl7) | 0;
        mid = mid + Math.imul(al0, bh7) | 0;
        mid = mid + Math.imul(ah0, bl7) | 0;
        hi = hi + Math.imul(ah0, bh7) | 0;
        var w7 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w7 >>> 26) | 0;
        w7 &= 67108863;
        lo = Math.imul(al8, bl0);
        mid = Math.imul(al8, bh0);
        mid = mid + Math.imul(ah8, bl0) | 0;
        hi = Math.imul(ah8, bh0);
        lo = lo + Math.imul(al7, bl1) | 0;
        mid = mid + Math.imul(al7, bh1) | 0;
        mid = mid + Math.imul(ah7, bl1) | 0;
        hi = hi + Math.imul(ah7, bh1) | 0;
        lo = lo + Math.imul(al6, bl2) | 0;
        mid = mid + Math.imul(al6, bh2) | 0;
        mid = mid + Math.imul(ah6, bl2) | 0;
        hi = hi + Math.imul(ah6, bh2) | 0;
        lo = lo + Math.imul(al5, bl3) | 0;
        mid = mid + Math.imul(al5, bh3) | 0;
        mid = mid + Math.imul(ah5, bl3) | 0;
        hi = hi + Math.imul(ah5, bh3) | 0;
        lo = lo + Math.imul(al4, bl4) | 0;
        mid = mid + Math.imul(al4, bh4) | 0;
        mid = mid + Math.imul(ah4, bl4) | 0;
        hi = hi + Math.imul(ah4, bh4) | 0;
        lo = lo + Math.imul(al3, bl5) | 0;
        mid = mid + Math.imul(al3, bh5) | 0;
        mid = mid + Math.imul(ah3, bl5) | 0;
        hi = hi + Math.imul(ah3, bh5) | 0;
        lo = lo + Math.imul(al2, bl6) | 0;
        mid = mid + Math.imul(al2, bh6) | 0;
        mid = mid + Math.imul(ah2, bl6) | 0;
        hi = hi + Math.imul(ah2, bh6) | 0;
        lo = lo + Math.imul(al1, bl7) | 0;
        mid = mid + Math.imul(al1, bh7) | 0;
        mid = mid + Math.imul(ah1, bl7) | 0;
        hi = hi + Math.imul(ah1, bh7) | 0;
        lo = lo + Math.imul(al0, bl8) | 0;
        mid = mid + Math.imul(al0, bh8) | 0;
        mid = mid + Math.imul(ah0, bl8) | 0;
        hi = hi + Math.imul(ah0, bh8) | 0;
        var w8 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w8 >>> 26) | 0;
        w8 &= 67108863;
        lo = Math.imul(al9, bl0);
        mid = Math.imul(al9, bh0);
        mid = mid + Math.imul(ah9, bl0) | 0;
        hi = Math.imul(ah9, bh0);
        lo = lo + Math.imul(al8, bl1) | 0;
        mid = mid + Math.imul(al8, bh1) | 0;
        mid = mid + Math.imul(ah8, bl1) | 0;
        hi = hi + Math.imul(ah8, bh1) | 0;
        lo = lo + Math.imul(al7, bl2) | 0;
        mid = mid + Math.imul(al7, bh2) | 0;
        mid = mid + Math.imul(ah7, bl2) | 0;
        hi = hi + Math.imul(ah7, bh2) | 0;
        lo = lo + Math.imul(al6, bl3) | 0;
        mid = mid + Math.imul(al6, bh3) | 0;
        mid = mid + Math.imul(ah6, bl3) | 0;
        hi = hi + Math.imul(ah6, bh3) | 0;
        lo = lo + Math.imul(al5, bl4) | 0;
        mid = mid + Math.imul(al5, bh4) | 0;
        mid = mid + Math.imul(ah5, bl4) | 0;
        hi = hi + Math.imul(ah5, bh4) | 0;
        lo = lo + Math.imul(al4, bl5) | 0;
        mid = mid + Math.imul(al4, bh5) | 0;
        mid = mid + Math.imul(ah4, bl5) | 0;
        hi = hi + Math.imul(ah4, bh5) | 0;
        lo = lo + Math.imul(al3, bl6) | 0;
        mid = mid + Math.imul(al3, bh6) | 0;
        mid = mid + Math.imul(ah3, bl6) | 0;
        hi = hi + Math.imul(ah3, bh6) | 0;
        lo = lo + Math.imul(al2, bl7) | 0;
        mid = mid + Math.imul(al2, bh7) | 0;
        mid = mid + Math.imul(ah2, bl7) | 0;
        hi = hi + Math.imul(ah2, bh7) | 0;
        lo = lo + Math.imul(al1, bl8) | 0;
        mid = mid + Math.imul(al1, bh8) | 0;
        mid = mid + Math.imul(ah1, bl8) | 0;
        hi = hi + Math.imul(ah1, bh8) | 0;
        lo = lo + Math.imul(al0, bl9) | 0;
        mid = mid + Math.imul(al0, bh9) | 0;
        mid = mid + Math.imul(ah0, bl9) | 0;
        hi = hi + Math.imul(ah0, bh9) | 0;
        var w9 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w9 >>> 26) | 0;
        w9 &= 67108863;
        lo = Math.imul(al9, bl1);
        mid = Math.imul(al9, bh1);
        mid = mid + Math.imul(ah9, bl1) | 0;
        hi = Math.imul(ah9, bh1);
        lo = lo + Math.imul(al8, bl2) | 0;
        mid = mid + Math.imul(al8, bh2) | 0;
        mid = mid + Math.imul(ah8, bl2) | 0;
        hi = hi + Math.imul(ah8, bh2) | 0;
        lo = lo + Math.imul(al7, bl3) | 0;
        mid = mid + Math.imul(al7, bh3) | 0;
        mid = mid + Math.imul(ah7, bl3) | 0;
        hi = hi + Math.imul(ah7, bh3) | 0;
        lo = lo + Math.imul(al6, bl4) | 0;
        mid = mid + Math.imul(al6, bh4) | 0;
        mid = mid + Math.imul(ah6, bl4) | 0;
        hi = hi + Math.imul(ah6, bh4) | 0;
        lo = lo + Math.imul(al5, bl5) | 0;
        mid = mid + Math.imul(al5, bh5) | 0;
        mid = mid + Math.imul(ah5, bl5) | 0;
        hi = hi + Math.imul(ah5, bh5) | 0;
        lo = lo + Math.imul(al4, bl6) | 0;
        mid = mid + Math.imul(al4, bh6) | 0;
        mid = mid + Math.imul(ah4, bl6) | 0;
        hi = hi + Math.imul(ah4, bh6) | 0;
        lo = lo + Math.imul(al3, bl7) | 0;
        mid = mid + Math.imul(al3, bh7) | 0;
        mid = mid + Math.imul(ah3, bl7) | 0;
        hi = hi + Math.imul(ah3, bh7) | 0;
        lo = lo + Math.imul(al2, bl8) | 0;
        mid = mid + Math.imul(al2, bh8) | 0;
        mid = mid + Math.imul(ah2, bl8) | 0;
        hi = hi + Math.imul(ah2, bh8) | 0;
        lo = lo + Math.imul(al1, bl9) | 0;
        mid = mid + Math.imul(al1, bh9) | 0;
        mid = mid + Math.imul(ah1, bl9) | 0;
        hi = hi + Math.imul(ah1, bh9) | 0;
        var w10 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w10 >>> 26) | 0;
        w10 &= 67108863;
        lo = Math.imul(al9, bl2);
        mid = Math.imul(al9, bh2);
        mid = mid + Math.imul(ah9, bl2) | 0;
        hi = Math.imul(ah9, bh2);
        lo = lo + Math.imul(al8, bl3) | 0;
        mid = mid + Math.imul(al8, bh3) | 0;
        mid = mid + Math.imul(ah8, bl3) | 0;
        hi = hi + Math.imul(ah8, bh3) | 0;
        lo = lo + Math.imul(al7, bl4) | 0;
        mid = mid + Math.imul(al7, bh4) | 0;
        mid = mid + Math.imul(ah7, bl4) | 0;
        hi = hi + Math.imul(ah7, bh4) | 0;
        lo = lo + Math.imul(al6, bl5) | 0;
        mid = mid + Math.imul(al6, bh5) | 0;
        mid = mid + Math.imul(ah6, bl5) | 0;
        hi = hi + Math.imul(ah6, bh5) | 0;
        lo = lo + Math.imul(al5, bl6) | 0;
        mid = mid + Math.imul(al5, bh6) | 0;
        mid = mid + Math.imul(ah5, bl6) | 0;
        hi = hi + Math.imul(ah5, bh6) | 0;
        lo = lo + Math.imul(al4, bl7) | 0;
        mid = mid + Math.imul(al4, bh7) | 0;
        mid = mid + Math.imul(ah4, bl7) | 0;
        hi = hi + Math.imul(ah4, bh7) | 0;
        lo = lo + Math.imul(al3, bl8) | 0;
        mid = mid + Math.imul(al3, bh8) | 0;
        mid = mid + Math.imul(ah3, bl8) | 0;
        hi = hi + Math.imul(ah3, bh8) | 0;
        lo = lo + Math.imul(al2, bl9) | 0;
        mid = mid + Math.imul(al2, bh9) | 0;
        mid = mid + Math.imul(ah2, bl9) | 0;
        hi = hi + Math.imul(ah2, bh9) | 0;
        var w11 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w11 >>> 26) | 0;
        w11 &= 67108863;
        lo = Math.imul(al9, bl3);
        mid = Math.imul(al9, bh3);
        mid = mid + Math.imul(ah9, bl3) | 0;
        hi = Math.imul(ah9, bh3);
        lo = lo + Math.imul(al8, bl4) | 0;
        mid = mid + Math.imul(al8, bh4) | 0;
        mid = mid + Math.imul(ah8, bl4) | 0;
        hi = hi + Math.imul(ah8, bh4) | 0;
        lo = lo + Math.imul(al7, bl5) | 0;
        mid = mid + Math.imul(al7, bh5) | 0;
        mid = mid + Math.imul(ah7, bl5) | 0;
        hi = hi + Math.imul(ah7, bh5) | 0;
        lo = lo + Math.imul(al6, bl6) | 0;
        mid = mid + Math.imul(al6, bh6) | 0;
        mid = mid + Math.imul(ah6, bl6) | 0;
        hi = hi + Math.imul(ah6, bh6) | 0;
        lo = lo + Math.imul(al5, bl7) | 0;
        mid = mid + Math.imul(al5, bh7) | 0;
        mid = mid + Math.imul(ah5, bl7) | 0;
        hi = hi + Math.imul(ah5, bh7) | 0;
        lo = lo + Math.imul(al4, bl8) | 0;
        mid = mid + Math.imul(al4, bh8) | 0;
        mid = mid + Math.imul(ah4, bl8) | 0;
        hi = hi + Math.imul(ah4, bh8) | 0;
        lo = lo + Math.imul(al3, bl9) | 0;
        mid = mid + Math.imul(al3, bh9) | 0;
        mid = mid + Math.imul(ah3, bl9) | 0;
        hi = hi + Math.imul(ah3, bh9) | 0;
        var w12 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w12 >>> 26) | 0;
        w12 &= 67108863;
        lo = Math.imul(al9, bl4);
        mid = Math.imul(al9, bh4);
        mid = mid + Math.imul(ah9, bl4) | 0;
        hi = Math.imul(ah9, bh4);
        lo = lo + Math.imul(al8, bl5) | 0;
        mid = mid + Math.imul(al8, bh5) | 0;
        mid = mid + Math.imul(ah8, bl5) | 0;
        hi = hi + Math.imul(ah8, bh5) | 0;
        lo = lo + Math.imul(al7, bl6) | 0;
        mid = mid + Math.imul(al7, bh6) | 0;
        mid = mid + Math.imul(ah7, bl6) | 0;
        hi = hi + Math.imul(ah7, bh6) | 0;
        lo = lo + Math.imul(al6, bl7) | 0;
        mid = mid + Math.imul(al6, bh7) | 0;
        mid = mid + Math.imul(ah6, bl7) | 0;
        hi = hi + Math.imul(ah6, bh7) | 0;
        lo = lo + Math.imul(al5, bl8) | 0;
        mid = mid + Math.imul(al5, bh8) | 0;
        mid = mid + Math.imul(ah5, bl8) | 0;
        hi = hi + Math.imul(ah5, bh8) | 0;
        lo = lo + Math.imul(al4, bl9) | 0;
        mid = mid + Math.imul(al4, bh9) | 0;
        mid = mid + Math.imul(ah4, bl9) | 0;
        hi = hi + Math.imul(ah4, bh9) | 0;
        var w13 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w13 >>> 26) | 0;
        w13 &= 67108863;
        lo = Math.imul(al9, bl5);
        mid = Math.imul(al9, bh5);
        mid = mid + Math.imul(ah9, bl5) | 0;
        hi = Math.imul(ah9, bh5);
        lo = lo + Math.imul(al8, bl6) | 0;
        mid = mid + Math.imul(al8, bh6) | 0;
        mid = mid + Math.imul(ah8, bl6) | 0;
        hi = hi + Math.imul(ah8, bh6) | 0;
        lo = lo + Math.imul(al7, bl7) | 0;
        mid = mid + Math.imul(al7, bh7) | 0;
        mid = mid + Math.imul(ah7, bl7) | 0;
        hi = hi + Math.imul(ah7, bh7) | 0;
        lo = lo + Math.imul(al6, bl8) | 0;
        mid = mid + Math.imul(al6, bh8) | 0;
        mid = mid + Math.imul(ah6, bl8) | 0;
        hi = hi + Math.imul(ah6, bh8) | 0;
        lo = lo + Math.imul(al5, bl9) | 0;
        mid = mid + Math.imul(al5, bh9) | 0;
        mid = mid + Math.imul(ah5, bl9) | 0;
        hi = hi + Math.imul(ah5, bh9) | 0;
        var w14 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w14 >>> 26) | 0;
        w14 &= 67108863;
        lo = Math.imul(al9, bl6);
        mid = Math.imul(al9, bh6);
        mid = mid + Math.imul(ah9, bl6) | 0;
        hi = Math.imul(ah9, bh6);
        lo = lo + Math.imul(al8, bl7) | 0;
        mid = mid + Math.imul(al8, bh7) | 0;
        mid = mid + Math.imul(ah8, bl7) | 0;
        hi = hi + Math.imul(ah8, bh7) | 0;
        lo = lo + Math.imul(al7, bl8) | 0;
        mid = mid + Math.imul(al7, bh8) | 0;
        mid = mid + Math.imul(ah7, bl8) | 0;
        hi = hi + Math.imul(ah7, bh8) | 0;
        lo = lo + Math.imul(al6, bl9) | 0;
        mid = mid + Math.imul(al6, bh9) | 0;
        mid = mid + Math.imul(ah6, bl9) | 0;
        hi = hi + Math.imul(ah6, bh9) | 0;
        var w15 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w15 >>> 26) | 0;
        w15 &= 67108863;
        lo = Math.imul(al9, bl7);
        mid = Math.imul(al9, bh7);
        mid = mid + Math.imul(ah9, bl7) | 0;
        hi = Math.imul(ah9, bh7);
        lo = lo + Math.imul(al8, bl8) | 0;
        mid = mid + Math.imul(al8, bh8) | 0;
        mid = mid + Math.imul(ah8, bl8) | 0;
        hi = hi + Math.imul(ah8, bh8) | 0;
        lo = lo + Math.imul(al7, bl9) | 0;
        mid = mid + Math.imul(al7, bh9) | 0;
        mid = mid + Math.imul(ah7, bl9) | 0;
        hi = hi + Math.imul(ah7, bh9) | 0;
        var w16 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w16 >>> 26) | 0;
        w16 &= 67108863;
        lo = Math.imul(al9, bl8);
        mid = Math.imul(al9, bh8);
        mid = mid + Math.imul(ah9, bl8) | 0;
        hi = Math.imul(ah9, bh8);
        lo = lo + Math.imul(al8, bl9) | 0;
        mid = mid + Math.imul(al8, bh9) | 0;
        mid = mid + Math.imul(ah8, bl9) | 0;
        hi = hi + Math.imul(ah8, bh9) | 0;
        var w17 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w17 >>> 26) | 0;
        w17 &= 67108863;
        lo = Math.imul(al9, bl9);
        mid = Math.imul(al9, bh9);
        mid = mid + Math.imul(ah9, bl9) | 0;
        hi = Math.imul(ah9, bh9);
        var w18 = (c + lo | 0) + ((mid & 8191) << 13) | 0;
        c = (hi + (mid >>> 13) | 0) + (w18 >>> 26) | 0;
        w18 &= 67108863;
        o[0] = w0;
        o[1] = w1;
        o[2] = w2;
        o[3] = w3;
        o[4] = w4;
        o[5] = w5;
        o[6] = w6;
        o[7] = w7;
        o[8] = w8;
        o[9] = w9;
        o[10] = w10;
        o[11] = w11;
        o[12] = w12;
        o[13] = w13;
        o[14] = w14;
        o[15] = w15;
        o[16] = w16;
        o[17] = w17;
        o[18] = w18;
        if (c !== 0) {
          o[19] = c;
          out.length++;
        }
        return out;
      };
      if (!Math.imul) {
        comb10MulTo = smallMulTo;
      }
      function bigMulTo(self, num2, out) {
        out.negative = num2.negative ^ self.negative;
        out.length = self.length + num2.length;
        var carry = 0;
        var hncarry = 0;
        for (var k = 0; k < out.length - 1; k++) {
          var ncarry = hncarry;
          hncarry = 0;
          var rword = carry & 67108863;
          var maxJ = Math.min(k, num2.length - 1);
          for (var j = Math.max(0, k - self.length + 1); j <= maxJ; j++) {
            var i = k - j;
            var a = self.words[i] | 0;
            var b = num2.words[j] | 0;
            var r = a * b;
            var lo = r & 67108863;
            ncarry = ncarry + (r / 67108864 | 0) | 0;
            lo = lo + rword | 0;
            rword = lo & 67108863;
            ncarry = ncarry + (lo >>> 26) | 0;
            hncarry += ncarry >>> 26;
            ncarry &= 67108863;
          }
          out.words[k] = rword;
          carry = ncarry;
          ncarry = hncarry;
        }
        if (carry !== 0) {
          out.words[k] = carry;
        } else {
          out.length--;
        }
        return out._strip();
      }
      function jumboMulTo(self, num2, out) {
        return bigMulTo(self, num2, out);
      }
      BN7.prototype.mulTo = function mulTo(num2, out) {
        var res;
        var len = this.length + num2.length;
        if (this.length === 10 && num2.length === 10) {
          res = comb10MulTo(this, num2, out);
        } else if (len < 63) {
          res = smallMulTo(this, num2, out);
        } else if (len < 1024) {
          res = bigMulTo(this, num2, out);
        } else {
          res = jumboMulTo(this, num2, out);
        }
        return res;
      };
      function FFTM(x, y) {
        this.x = x;
        this.y = y;
      }
      FFTM.prototype.makeRBT = function makeRBT(N) {
        var t = new Array(N);
        var l = BN7.prototype._countBits(N) - 1;
        for (var i = 0; i < N; i++) {
          t[i] = this.revBin(i, l, N);
        }
        return t;
      };
      FFTM.prototype.revBin = function revBin(x, l, N) {
        if (x === 0 || x === N - 1) return x;
        var rb = 0;
        for (var i = 0; i < l; i++) {
          rb |= (x & 1) << l - i - 1;
          x >>= 1;
        }
        return rb;
      };
      FFTM.prototype.permute = function permute(rbt, rws, iws, rtws, itws, N) {
        for (var i = 0; i < N; i++) {
          rtws[i] = rws[rbt[i]];
          itws[i] = iws[rbt[i]];
        }
      };
      FFTM.prototype.transform = function transform(rws, iws, rtws, itws, N, rbt) {
        this.permute(rbt, rws, iws, rtws, itws, N);
        for (var s = 1; s < N; s <<= 1) {
          var l = s << 1;
          var rtwdf = Math.cos(2 * Math.PI / l);
          var itwdf = Math.sin(2 * Math.PI / l);
          for (var p = 0; p < N; p += l) {
            var rtwdf_ = rtwdf;
            var itwdf_ = itwdf;
            for (var j = 0; j < s; j++) {
              var re = rtws[p + j];
              var ie = itws[p + j];
              var ro = rtws[p + j + s];
              var io = itws[p + j + s];
              var rx = rtwdf_ * ro - itwdf_ * io;
              io = rtwdf_ * io + itwdf_ * ro;
              ro = rx;
              rtws[p + j] = re + ro;
              itws[p + j] = ie + io;
              rtws[p + j + s] = re - ro;
              itws[p + j + s] = ie - io;
              if (j !== l) {
                rx = rtwdf * rtwdf_ - itwdf * itwdf_;
                itwdf_ = rtwdf * itwdf_ + itwdf * rtwdf_;
                rtwdf_ = rx;
              }
            }
          }
        }
      };
      FFTM.prototype.guessLen13b = function guessLen13b(n, m) {
        var N = Math.max(m, n) | 1;
        var odd = N & 1;
        var i = 0;
        for (N = N / 2 | 0; N; N = N >>> 1) {
          i++;
        }
        return 1 << i + 1 + odd;
      };
      FFTM.prototype.conjugate = function conjugate(rws, iws, N) {
        if (N <= 1) return;
        for (var i = 0; i < N / 2; i++) {
          var t = rws[i];
          rws[i] = rws[N - i - 1];
          rws[N - i - 1] = t;
          t = iws[i];
          iws[i] = -iws[N - i - 1];
          iws[N - i - 1] = -t;
        }
      };
      FFTM.prototype.normalize13b = function normalize13b(ws, N) {
        var carry = 0;
        for (var i = 0; i < N / 2; i++) {
          var w = Math.round(ws[2 * i + 1] / N) * 8192 + Math.round(ws[2 * i] / N) + carry;
          ws[i] = w & 67108863;
          if (w < 67108864) {
            carry = 0;
          } else {
            carry = w / 67108864 | 0;
          }
        }
        return ws;
      };
      FFTM.prototype.convert13b = function convert13b(ws, len, rws, N) {
        var carry = 0;
        for (var i = 0; i < len; i++) {
          carry = carry + (ws[i] | 0);
          rws[2 * i] = carry & 8191;
          carry = carry >>> 13;
          rws[2 * i + 1] = carry & 8191;
          carry = carry >>> 13;
        }
        for (i = 2 * len; i < N; ++i) {
          rws[i] = 0;
        }
        assert(carry === 0);
        assert((carry & ~8191) === 0);
      };
      FFTM.prototype.stub = function stub(N) {
        var ph = new Array(N);
        for (var i = 0; i < N; i++) {
          ph[i] = 0;
        }
        return ph;
      };
      FFTM.prototype.mulp = function mulp(x, y, out) {
        var N = 2 * this.guessLen13b(x.length, y.length);
        var rbt = this.makeRBT(N);
        var _ = this.stub(N);
        var rws = new Array(N);
        var rwst = new Array(N);
        var iwst = new Array(N);
        var nrws = new Array(N);
        var nrwst = new Array(N);
        var niwst = new Array(N);
        var rmws = out.words;
        rmws.length = N;
        this.convert13b(x.words, x.length, rws, N);
        this.convert13b(y.words, y.length, nrws, N);
        this.transform(rws, _, rwst, iwst, N, rbt);
        this.transform(nrws, _, nrwst, niwst, N, rbt);
        for (var i = 0; i < N; i++) {
          var rx = rwst[i] * nrwst[i] - iwst[i] * niwst[i];
          iwst[i] = rwst[i] * niwst[i] + iwst[i] * nrwst[i];
          rwst[i] = rx;
        }
        this.conjugate(rwst, iwst, N);
        this.transform(rwst, iwst, rmws, _, N, rbt);
        this.conjugate(rmws, _, N);
        this.normalize13b(rmws, N);
        out.negative = x.negative ^ y.negative;
        out.length = x.length + y.length;
        return out._strip();
      };
      BN7.prototype.mul = function mul(num2) {
        var out = new BN7(null);
        out.words = new Array(this.length + num2.length);
        return this.mulTo(num2, out);
      };
      BN7.prototype.mulf = function mulf(num2) {
        var out = new BN7(null);
        out.words = new Array(this.length + num2.length);
        return jumboMulTo(this, num2, out);
      };
      BN7.prototype.imul = function imul(num2) {
        return this.clone().mulTo(num2, this);
      };
      BN7.prototype.imuln = function imuln(num2) {
        var isNegNum = num2 < 0;
        if (isNegNum) num2 = -num2;
        assert(typeof num2 === "number");
        assert(num2 < 67108864);
        var carry = 0;
        for (var i = 0; i < this.length; i++) {
          var w = (this.words[i] | 0) * num2;
          var lo = (w & 67108863) + (carry & 67108863);
          carry >>= 26;
          carry += w / 67108864 | 0;
          carry += lo >>> 26;
          this.words[i] = lo & 67108863;
        }
        if (carry !== 0) {
          this.words[i] = carry;
          this.length++;
        }
        if (num2 === 0) {
          this.length = 1;
          this._normSign();
        }
        return isNegNum ? this.ineg() : this;
      };
      BN7.prototype.muln = function muln(num2) {
        return this.clone().imuln(num2);
      };
      BN7.prototype.sqr = function sqr() {
        return this.mul(this);
      };
      BN7.prototype.isqr = function isqr() {
        return this.imul(this.clone());
      };
      BN7.prototype.pow = function pow(num2) {
        var w = toBitArray(num2);
        if (w.length === 0) return new BN7(1);
        var res = this;
        for (var i = 0; i < w.length; i++, res = res.sqr()) {
          if (w[i] !== 0) break;
        }
        if (++i < w.length) {
          for (var q = res.sqr(); i < w.length; i++, q = q.sqr()) {
            if (w[i] === 0) continue;
            res = res.mul(q);
          }
        }
        return res;
      };
      BN7.prototype.iushln = function iushln(bits) {
        assert(typeof bits === "number" && bits >= 0);
        var r = bits % 26;
        var s = (bits - r) / 26;
        var carryMask = 67108863 >>> 26 - r << 26 - r;
        var i;
        if (r !== 0) {
          var carry = 0;
          for (i = 0; i < this.length; i++) {
            var newCarry = this.words[i] & carryMask;
            var c = (this.words[i] | 0) - newCarry << r;
            this.words[i] = c | carry;
            carry = newCarry >>> 26 - r;
          }
          if (carry) {
            this.words[i] = carry;
            this.length++;
          }
        }
        if (s !== 0) {
          for (i = this.length - 1; i >= 0; i--) {
            this.words[i + s] = this.words[i];
          }
          for (i = 0; i < s; i++) {
            this.words[i] = 0;
          }
          this.length += s;
        }
        return this._strip();
      };
      BN7.prototype.ishln = function ishln(bits) {
        assert(this.negative === 0);
        return this.iushln(bits);
      };
      BN7.prototype.iushrn = function iushrn(bits, hint, extended) {
        assert(typeof bits === "number" && bits >= 0);
        var h;
        if (hint) {
          h = (hint - hint % 26) / 26;
        } else {
          h = 0;
        }
        var r = bits % 26;
        var s = Math.min((bits - r) / 26, this.length);
        var mask = 67108863 ^ 67108863 >>> r << r;
        var maskedWords = extended;
        h -= s;
        h = Math.max(0, h);
        if (maskedWords) {
          for (var i = 0; i < s; i++) {
            maskedWords.words[i] = this.words[i];
          }
          maskedWords.length = s;
        }
        if (s === 0) {
        } else if (this.length > s) {
          this.length -= s;
          for (i = 0; i < this.length; i++) {
            this.words[i] = this.words[i + s];
          }
        } else {
          this.words[0] = 0;
          this.length = 1;
        }
        var carry = 0;
        for (i = this.length - 1; i >= 0 && (carry !== 0 || i >= h); i--) {
          var word = this.words[i] | 0;
          this.words[i] = carry << 26 - r | word >>> r;
          carry = word & mask;
        }
        if (maskedWords && carry !== 0) {
          maskedWords.words[maskedWords.length++] = carry;
        }
        if (this.length === 0) {
          this.words[0] = 0;
          this.length = 1;
        }
        return this._strip();
      };
      BN7.prototype.ishrn = function ishrn(bits, hint, extended) {
        assert(this.negative === 0);
        return this.iushrn(bits, hint, extended);
      };
      BN7.prototype.shln = function shln(bits) {
        return this.clone().ishln(bits);
      };
      BN7.prototype.ushln = function ushln(bits) {
        return this.clone().iushln(bits);
      };
      BN7.prototype.shrn = function shrn(bits) {
        return this.clone().ishrn(bits);
      };
      BN7.prototype.ushrn = function ushrn(bits) {
        return this.clone().iushrn(bits);
      };
      BN7.prototype.testn = function testn(bit) {
        assert(typeof bit === "number" && bit >= 0);
        var r = bit % 26;
        var s = (bit - r) / 26;
        var q = 1 << r;
        if (this.length <= s) return false;
        var w = this.words[s];
        return !!(w & q);
      };
      BN7.prototype.imaskn = function imaskn(bits) {
        assert(typeof bits === "number" && bits >= 0);
        var r = bits % 26;
        var s = (bits - r) / 26;
        assert(this.negative === 0, "imaskn works only with positive numbers");
        if (this.length <= s) {
          return this;
        }
        if (r !== 0) {
          s++;
        }
        this.length = Math.min(s, this.length);
        if (r !== 0) {
          var mask = 67108863 ^ 67108863 >>> r << r;
          this.words[this.length - 1] &= mask;
        }
        if (this.length === 0) {
          this.words[0] = 0;
          this.length = 1;
        }
        return this._strip();
      };
      BN7.prototype.maskn = function maskn(bits) {
        return this.clone().imaskn(bits);
      };
      BN7.prototype.iaddn = function iaddn(num2) {
        assert(typeof num2 === "number");
        assert(num2 < 67108864);
        if (num2 < 0) return this.isubn(-num2);
        if (this.negative !== 0) {
          if (this.length === 1 && (this.words[0] | 0) <= num2) {
            this.words[0] = num2 - (this.words[0] | 0);
            this.negative = 0;
            return this;
          }
          this.negative = 0;
          this.isubn(num2);
          this.negative = 1;
          return this;
        }
        return this._iaddn(num2);
      };
      BN7.prototype._iaddn = function _iaddn(num2) {
        this.words[0] += num2;
        for (var i = 0; i < this.length && this.words[i] >= 67108864; i++) {
          this.words[i] -= 67108864;
          if (i === this.length - 1) {
            this.words[i + 1] = 1;
          } else {
            this.words[i + 1]++;
          }
        }
        this.length = Math.max(this.length, i + 1);
        return this;
      };
      BN7.prototype.isubn = function isubn(num2) {
        assert(typeof num2 === "number");
        assert(num2 < 67108864);
        if (num2 < 0) return this.iaddn(-num2);
        if (this.negative !== 0) {
          this.negative = 0;
          this.iaddn(num2);
          this.negative = 1;
          return this;
        }
        this.words[0] -= num2;
        if (this.length === 1 && this.words[0] < 0) {
          this.words[0] = -this.words[0];
          this.negative = 1;
        } else {
          for (var i = 0; i < this.length && this.words[i] < 0; i++) {
            this.words[i] += 67108864;
            this.words[i + 1] -= 1;
          }
        }
        return this._strip();
      };
      BN7.prototype.addn = function addn(num2) {
        return this.clone().iaddn(num2);
      };
      BN7.prototype.subn = function subn(num2) {
        return this.clone().isubn(num2);
      };
      BN7.prototype.iabs = function iabs() {
        this.negative = 0;
        return this;
      };
      BN7.prototype.abs = function abs() {
        return this.clone().iabs();
      };
      BN7.prototype._ishlnsubmul = function _ishlnsubmul(num2, mul, shift) {
        var len = num2.length + shift;
        var i;
        this._expand(len);
        var w;
        var carry = 0;
        for (i = 0; i < num2.length; i++) {
          w = (this.words[i + shift] | 0) + carry;
          var right = (num2.words[i] | 0) * mul;
          w -= right & 67108863;
          carry = (w >> 26) - (right / 67108864 | 0);
          this.words[i + shift] = w & 67108863;
        }
        for (; i < this.length - shift; i++) {
          w = (this.words[i + shift] | 0) + carry;
          carry = w >> 26;
          this.words[i + shift] = w & 67108863;
        }
        if (carry === 0) return this._strip();
        assert(carry === -1);
        carry = 0;
        for (i = 0; i < this.length; i++) {
          w = -(this.words[i] | 0) + carry;
          carry = w >> 26;
          this.words[i] = w & 67108863;
        }
        this.negative = 1;
        return this._strip();
      };
      BN7.prototype._wordDiv = function _wordDiv(num2, mode) {
        var shift = this.length - num2.length;
        var a = this.clone();
        var b = num2;
        var bhi = b.words[b.length - 1] | 0;
        var bhiBits = this._countBits(bhi);
        shift = 26 - bhiBits;
        if (shift !== 0) {
          b = b.ushln(shift);
          a.iushln(shift);
          bhi = b.words[b.length - 1] | 0;
        }
        var m = a.length - b.length;
        var q;
        if (mode !== "mod") {
          q = new BN7(null);
          q.length = m + 1;
          q.words = new Array(q.length);
          for (var i = 0; i < q.length; i++) {
            q.words[i] = 0;
          }
        }
        var diff = a.clone()._ishlnsubmul(b, 1, m);
        if (diff.negative === 0) {
          a = diff;
          if (q) {
            q.words[m] = 1;
          }
        }
        for (var j = m - 1; j >= 0; j--) {
          var qj = (a.words[b.length + j] | 0) * 67108864 + (a.words[b.length + j - 1] | 0);
          qj = Math.min(qj / bhi | 0, 67108863);
          a._ishlnsubmul(b, qj, j);
          while (a.negative !== 0) {
            qj--;
            a.negative = 0;
            a._ishlnsubmul(b, 1, j);
            if (!a.isZero()) {
              a.negative ^= 1;
            }
          }
          if (q) {
            q.words[j] = qj;
          }
        }
        if (q) {
          q._strip();
        }
        a._strip();
        if (mode !== "div" && shift !== 0) {
          a.iushrn(shift);
        }
        return {
          div: q || null,
          mod: a
        };
      };
      BN7.prototype.divmod = function divmod(num2, mode, positive) {
        assert(!num2.isZero());
        if (this.isZero()) {
          return {
            div: new BN7(0),
            mod: new BN7(0)
          };
        }
        var div, mod, res;
        if (this.negative !== 0 && num2.negative === 0) {
          res = this.neg().divmod(num2, mode);
          if (mode !== "mod") {
            div = res.div.neg();
          }
          if (mode !== "div") {
            mod = res.mod.neg();
            if (positive && mod.negative !== 0) {
              mod.iadd(num2);
            }
          }
          return {
            div,
            mod
          };
        }
        if (this.negative === 0 && num2.negative !== 0) {
          res = this.divmod(num2.neg(), mode);
          if (mode !== "mod") {
            div = res.div.neg();
          }
          return {
            div,
            mod: res.mod
          };
        }
        if ((this.negative & num2.negative) !== 0) {
          res = this.neg().divmod(num2.neg(), mode);
          if (mode !== "div") {
            mod = res.mod.neg();
            if (positive && mod.negative !== 0) {
              mod.isub(num2);
            }
          }
          return {
            div: res.div,
            mod
          };
        }
        if (num2.length > this.length || this.cmp(num2) < 0) {
          return {
            div: new BN7(0),
            mod: this
          };
        }
        if (num2.length === 1) {
          if (mode === "div") {
            return {
              div: this.divn(num2.words[0]),
              mod: null
            };
          }
          if (mode === "mod") {
            return {
              div: null,
              mod: new BN7(this.modrn(num2.words[0]))
            };
          }
          return {
            div: this.divn(num2.words[0]),
            mod: new BN7(this.modrn(num2.words[0]))
          };
        }
        return this._wordDiv(num2, mode);
      };
      BN7.prototype.div = function div(num2) {
        return this.divmod(num2, "div", false).div;
      };
      BN7.prototype.mod = function mod(num2) {
        return this.divmod(num2, "mod", false).mod;
      };
      BN7.prototype.umod = function umod(num2) {
        return this.divmod(num2, "mod", true).mod;
      };
      BN7.prototype.divRound = function divRound(num2) {
        var dm = this.divmod(num2);
        if (dm.mod.isZero()) return dm.div;
        var mod = dm.mod.abs();
        var half = num2.abs().iushrn(1);
        var r2 = num2.words[0] & 1;
        var cmp = mod.cmp(half);
        if (cmp < 0 || r2 === 1 && cmp === 0) return dm.div;
        var up = new BN7(1);
        up.negative = this.negative ^ num2.negative;
        return dm.div.iadd(up);
      };
      BN7.prototype.modrn = function modrn(num2) {
        var isNegNum = num2 < 0;
        if (isNegNum) num2 = -num2;
        assert(num2 <= 67108863);
        var p = (1 << 26) % num2;
        var acc = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          acc = (p * acc + (this.words[i] | 0)) % num2;
        }
        return isNegNum ? -acc : acc;
      };
      BN7.prototype.modn = function modn(num2) {
        return this.modrn(num2);
      };
      BN7.prototype.idivn = function idivn(num2) {
        var isNegNum = num2 < 0;
        if (isNegNum) num2 = -num2;
        assert(num2 <= 67108863);
        var carry = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          var w = (this.words[i] | 0) + carry * 67108864;
          this.words[i] = w / num2 | 0;
          carry = w % num2;
        }
        this._strip();
        return isNegNum ? this.ineg() : this;
      };
      BN7.prototype.divn = function divn(num2) {
        return this.clone().idivn(num2);
      };
      BN7.prototype.egcd = function egcd(p) {
        assert(p.negative === 0);
        assert(!p.isZero());
        var x = this;
        var y = p.clone();
        if (x.negative !== 0) {
          x = x.umod(p);
        } else {
          x = x.clone();
        }
        var A = new BN7(1);
        var B = new BN7(0);
        var C = new BN7(0);
        var D = new BN7(1);
        var g = 0;
        while (x.isEven() && y.isEven()) {
          x.iushrn(1);
          y.iushrn(1);
          ++g;
        }
        var yp = y.clone();
        var xp = x.clone();
        while (!x.isZero()) {
          for (var i = 0, im = 1; (x.words[0] & im) === 0 && i < 26; ++i, im <<= 1) ;
          if (i > 0) {
            x.iushrn(i);
            while (i-- > 0) {
              if (A.isOdd() || B.isOdd()) {
                A.iadd(yp);
                B.isub(xp);
              }
              A.iushrn(1);
              B.iushrn(1);
            }
          }
          for (var j = 0, jm = 1; (y.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1) ;
          if (j > 0) {
            y.iushrn(j);
            while (j-- > 0) {
              if (C.isOdd() || D.isOdd()) {
                C.iadd(yp);
                D.isub(xp);
              }
              C.iushrn(1);
              D.iushrn(1);
            }
          }
          if (x.cmp(y) >= 0) {
            x.isub(y);
            A.isub(C);
            B.isub(D);
          } else {
            y.isub(x);
            C.isub(A);
            D.isub(B);
          }
        }
        return {
          a: C,
          b: D,
          gcd: y.iushln(g)
        };
      };
      BN7.prototype._invmp = function _invmp(p) {
        assert(p.negative === 0);
        assert(!p.isZero());
        var a = this;
        var b = p.clone();
        if (a.negative !== 0) {
          a = a.umod(p);
        } else {
          a = a.clone();
        }
        var x1 = new BN7(1);
        var x2 = new BN7(0);
        var delta = b.clone();
        while (a.cmpn(1) > 0 && b.cmpn(1) > 0) {
          for (var i = 0, im = 1; (a.words[0] & im) === 0 && i < 26; ++i, im <<= 1) ;
          if (i > 0) {
            a.iushrn(i);
            while (i-- > 0) {
              if (x1.isOdd()) {
                x1.iadd(delta);
              }
              x1.iushrn(1);
            }
          }
          for (var j = 0, jm = 1; (b.words[0] & jm) === 0 && j < 26; ++j, jm <<= 1) ;
          if (j > 0) {
            b.iushrn(j);
            while (j-- > 0) {
              if (x2.isOdd()) {
                x2.iadd(delta);
              }
              x2.iushrn(1);
            }
          }
          if (a.cmp(b) >= 0) {
            a.isub(b);
            x1.isub(x2);
          } else {
            b.isub(a);
            x2.isub(x1);
          }
        }
        var res;
        if (a.cmpn(1) === 0) {
          res = x1;
        } else {
          res = x2;
        }
        if (res.cmpn(0) < 0) {
          res.iadd(p);
        }
        return res;
      };
      BN7.prototype.gcd = function gcd(num2) {
        if (this.isZero()) return num2.abs();
        if (num2.isZero()) return this.abs();
        var a = this.clone();
        var b = num2.clone();
        a.negative = 0;
        b.negative = 0;
        for (var shift = 0; a.isEven() && b.isEven(); shift++) {
          a.iushrn(1);
          b.iushrn(1);
        }
        do {
          while (a.isEven()) {
            a.iushrn(1);
          }
          while (b.isEven()) {
            b.iushrn(1);
          }
          var r = a.cmp(b);
          if (r < 0) {
            var t = a;
            a = b;
            b = t;
          } else if (r === 0 || b.cmpn(1) === 0) {
            break;
          }
          a.isub(b);
        } while (true);
        return b.iushln(shift);
      };
      BN7.prototype.invm = function invm(num2) {
        return this.egcd(num2).a.umod(num2);
      };
      BN7.prototype.isEven = function isEven() {
        return (this.words[0] & 1) === 0;
      };
      BN7.prototype.isOdd = function isOdd() {
        return (this.words[0] & 1) === 1;
      };
      BN7.prototype.andln = function andln(num2) {
        return this.words[0] & num2;
      };
      BN7.prototype.bincn = function bincn(bit) {
        assert(typeof bit === "number");
        var r = bit % 26;
        var s = (bit - r) / 26;
        var q = 1 << r;
        if (this.length <= s) {
          this._expand(s + 1);
          this.words[s] |= q;
          return this;
        }
        var carry = q;
        for (var i = s; carry !== 0 && i < this.length; i++) {
          var w = this.words[i] | 0;
          w += carry;
          carry = w >>> 26;
          w &= 67108863;
          this.words[i] = w;
        }
        if (carry !== 0) {
          this.words[i] = carry;
          this.length++;
        }
        return this;
      };
      BN7.prototype.isZero = function isZero() {
        return this.length === 1 && this.words[0] === 0;
      };
      BN7.prototype.cmpn = function cmpn(num2) {
        var negative = num2 < 0;
        if (this.negative !== 0 && !negative) return -1;
        if (this.negative === 0 && negative) return 1;
        this._strip();
        var res;
        if (this.length > 1) {
          res = 1;
        } else {
          if (negative) {
            num2 = -num2;
          }
          assert(num2 <= 67108863, "Number is too big");
          var w = this.words[0] | 0;
          res = w === num2 ? 0 : w < num2 ? -1 : 1;
        }
        if (this.negative !== 0) return -res | 0;
        return res;
      };
      BN7.prototype.cmp = function cmp(num2) {
        if (this.negative !== 0 && num2.negative === 0) return -1;
        if (this.negative === 0 && num2.negative !== 0) return 1;
        var res = this.ucmp(num2);
        if (this.negative !== 0) return -res | 0;
        return res;
      };
      BN7.prototype.ucmp = function ucmp(num2) {
        if (this.length > num2.length) return 1;
        if (this.length < num2.length) return -1;
        var res = 0;
        for (var i = this.length - 1; i >= 0; i--) {
          var a = this.words[i] | 0;
          var b = num2.words[i] | 0;
          if (a === b) continue;
          if (a < b) {
            res = -1;
          } else if (a > b) {
            res = 1;
          }
          break;
        }
        return res;
      };
      BN7.prototype.gtn = function gtn(num2) {
        return this.cmpn(num2) === 1;
      };
      BN7.prototype.gt = function gt(num2) {
        return this.cmp(num2) === 1;
      };
      BN7.prototype.gten = function gten(num2) {
        return this.cmpn(num2) >= 0;
      };
      BN7.prototype.gte = function gte(num2) {
        return this.cmp(num2) >= 0;
      };
      BN7.prototype.ltn = function ltn(num2) {
        return this.cmpn(num2) === -1;
      };
      BN7.prototype.lt = function lt(num2) {
        return this.cmp(num2) === -1;
      };
      BN7.prototype.lten = function lten(num2) {
        return this.cmpn(num2) <= 0;
      };
      BN7.prototype.lte = function lte(num2) {
        return this.cmp(num2) <= 0;
      };
      BN7.prototype.eqn = function eqn(num2) {
        return this.cmpn(num2) === 0;
      };
      BN7.prototype.eq = function eq(num2) {
        return this.cmp(num2) === 0;
      };
      BN7.red = function red(num2) {
        return new Red(num2);
      };
      BN7.prototype.toRed = function toRed(ctx) {
        assert(!this.red, "Already a number in reduction context");
        assert(this.negative === 0, "red works only with positives");
        return ctx.convertTo(this)._forceRed(ctx);
      };
      BN7.prototype.fromRed = function fromRed() {
        assert(this.red, "fromRed works only with numbers in reduction context");
        return this.red.convertFrom(this);
      };
      BN7.prototype._forceRed = function _forceRed(ctx) {
        this.red = ctx;
        return this;
      };
      BN7.prototype.forceRed = function forceRed(ctx) {
        assert(!this.red, "Already a number in reduction context");
        return this._forceRed(ctx);
      };
      BN7.prototype.redAdd = function redAdd(num2) {
        assert(this.red, "redAdd works only with red numbers");
        return this.red.add(this, num2);
      };
      BN7.prototype.redIAdd = function redIAdd(num2) {
        assert(this.red, "redIAdd works only with red numbers");
        return this.red.iadd(this, num2);
      };
      BN7.prototype.redSub = function redSub(num2) {
        assert(this.red, "redSub works only with red numbers");
        return this.red.sub(this, num2);
      };
      BN7.prototype.redISub = function redISub(num2) {
        assert(this.red, "redISub works only with red numbers");
        return this.red.isub(this, num2);
      };
      BN7.prototype.redShl = function redShl(num2) {
        assert(this.red, "redShl works only with red numbers");
        return this.red.shl(this, num2);
      };
      BN7.prototype.redMul = function redMul(num2) {
        assert(this.red, "redMul works only with red numbers");
        this.red._verify2(this, num2);
        return this.red.mul(this, num2);
      };
      BN7.prototype.redIMul = function redIMul(num2) {
        assert(this.red, "redMul works only with red numbers");
        this.red._verify2(this, num2);
        return this.red.imul(this, num2);
      };
      BN7.prototype.redSqr = function redSqr() {
        assert(this.red, "redSqr works only with red numbers");
        this.red._verify1(this);
        return this.red.sqr(this);
      };
      BN7.prototype.redISqr = function redISqr() {
        assert(this.red, "redISqr works only with red numbers");
        this.red._verify1(this);
        return this.red.isqr(this);
      };
      BN7.prototype.redSqrt = function redSqrt() {
        assert(this.red, "redSqrt works only with red numbers");
        this.red._verify1(this);
        return this.red.sqrt(this);
      };
      BN7.prototype.redInvm = function redInvm() {
        assert(this.red, "redInvm works only with red numbers");
        this.red._verify1(this);
        return this.red.invm(this);
      };
      BN7.prototype.redNeg = function redNeg() {
        assert(this.red, "redNeg works only with red numbers");
        this.red._verify1(this);
        return this.red.neg(this);
      };
      BN7.prototype.redPow = function redPow(num2) {
        assert(this.red && !num2.red, "redPow(normalNum)");
        this.red._verify1(this);
        return this.red.pow(this, num2);
      };
      var primes = {
        k256: null,
        p224: null,
        p192: null,
        p25519: null
      };
      function MPrime(name, p) {
        this.name = name;
        this.p = new BN7(p, 16);
        this.n = this.p.bitLength();
        this.k = new BN7(1).iushln(this.n).isub(this.p);
        this.tmp = this._tmp();
      }
      MPrime.prototype._tmp = function _tmp() {
        var tmp = new BN7(null);
        tmp.words = new Array(Math.ceil(this.n / 13));
        return tmp;
      };
      MPrime.prototype.ireduce = function ireduce(num2) {
        var r = num2;
        var rlen;
        do {
          this.split(r, this.tmp);
          r = this.imulK(r);
          r = r.iadd(this.tmp);
          rlen = r.bitLength();
        } while (rlen > this.n);
        var cmp = rlen < this.n ? -1 : r.ucmp(this.p);
        if (cmp === 0) {
          r.words[0] = 0;
          r.length = 1;
        } else if (cmp > 0) {
          r.isub(this.p);
        } else {
          if (r.strip !== void 0) {
            r.strip();
          } else {
            r._strip();
          }
        }
        return r;
      };
      MPrime.prototype.split = function split(input, out) {
        input.iushrn(this.n, 0, out);
      };
      MPrime.prototype.imulK = function imulK(num2) {
        return num2.imul(this.k);
      };
      function K256() {
        MPrime.call(
          this,
          "k256",
          "ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff fffffffe fffffc2f"
        );
      }
      inherits(K256, MPrime);
      K256.prototype.split = function split(input, output) {
        var mask = 4194303;
        var outLen = Math.min(input.length, 9);
        for (var i = 0; i < outLen; i++) {
          output.words[i] = input.words[i];
        }
        output.length = outLen;
        if (input.length <= 9) {
          input.words[0] = 0;
          input.length = 1;
          return;
        }
        var prev = input.words[9];
        output.words[output.length++] = prev & mask;
        for (i = 10; i < input.length; i++) {
          var next = input.words[i] | 0;
          input.words[i - 10] = (next & mask) << 4 | prev >>> 22;
          prev = next;
        }
        prev >>>= 22;
        input.words[i - 10] = prev;
        if (prev === 0 && input.length > 10) {
          input.length -= 10;
        } else {
          input.length -= 9;
        }
      };
      K256.prototype.imulK = function imulK(num2) {
        num2.words[num2.length] = 0;
        num2.words[num2.length + 1] = 0;
        num2.length += 2;
        var lo = 0;
        for (var i = 0; i < num2.length; i++) {
          var w = num2.words[i] | 0;
          lo += w * 977;
          num2.words[i] = lo & 67108863;
          lo = w * 64 + (lo / 67108864 | 0);
        }
        if (num2.words[num2.length - 1] === 0) {
          num2.length--;
          if (num2.words[num2.length - 1] === 0) {
            num2.length--;
          }
        }
        return num2;
      };
      function P224() {
        MPrime.call(
          this,
          "p224",
          "ffffffff ffffffff ffffffff ffffffff 00000000 00000000 00000001"
        );
      }
      inherits(P224, MPrime);
      function P192() {
        MPrime.call(
          this,
          "p192",
          "ffffffff ffffffff ffffffff fffffffe ffffffff ffffffff"
        );
      }
      inherits(P192, MPrime);
      function P25519() {
        MPrime.call(
          this,
          "25519",
          "7fffffffffffffff ffffffffffffffff ffffffffffffffff ffffffffffffffed"
        );
      }
      inherits(P25519, MPrime);
      P25519.prototype.imulK = function imulK(num2) {
        var carry = 0;
        for (var i = 0; i < num2.length; i++) {
          var hi = (num2.words[i] | 0) * 19 + carry;
          var lo = hi & 67108863;
          hi >>>= 26;
          num2.words[i] = lo;
          carry = hi;
        }
        if (carry !== 0) {
          num2.words[num2.length++] = carry;
        }
        return num2;
      };
      BN7._prime = function prime(name) {
        if (primes[name]) return primes[name];
        var prime2;
        if (name === "k256") {
          prime2 = new K256();
        } else if (name === "p224") {
          prime2 = new P224();
        } else if (name === "p192") {
          prime2 = new P192();
        } else if (name === "p25519") {
          prime2 = new P25519();
        } else {
          throw new Error("Unknown prime " + name);
        }
        primes[name] = prime2;
        return prime2;
      };
      function Red(m) {
        if (typeof m === "string") {
          var prime = BN7._prime(m);
          this.m = prime.p;
          this.prime = prime;
        } else {
          assert(m.gtn(1), "modulus must be greater than 1");
          this.m = m;
          this.prime = null;
        }
      }
      Red.prototype._verify1 = function _verify1(a) {
        assert(a.negative === 0, "red works only with positives");
        assert(a.red, "red works only with red numbers");
      };
      Red.prototype._verify2 = function _verify2(a, b) {
        assert((a.negative | b.negative) === 0, "red works only with positives");
        assert(
          a.red && a.red === b.red,
          "red works only with red numbers"
        );
      };
      Red.prototype.imod = function imod(a) {
        if (this.prime) return this.prime.ireduce(a)._forceRed(this);
        move(a, a.umod(this.m)._forceRed(this));
        return a;
      };
      Red.prototype.neg = function neg(a) {
        if (a.isZero()) {
          return a.clone();
        }
        return this.m.sub(a)._forceRed(this);
      };
      Red.prototype.add = function add(a, b) {
        this._verify2(a, b);
        var res = a.add(b);
        if (res.cmp(this.m) >= 0) {
          res.isub(this.m);
        }
        return res._forceRed(this);
      };
      Red.prototype.iadd = function iadd(a, b) {
        this._verify2(a, b);
        var res = a.iadd(b);
        if (res.cmp(this.m) >= 0) {
          res.isub(this.m);
        }
        return res;
      };
      Red.prototype.sub = function sub(a, b) {
        this._verify2(a, b);
        var res = a.sub(b);
        if (res.cmpn(0) < 0) {
          res.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Red.prototype.isub = function isub(a, b) {
        this._verify2(a, b);
        var res = a.isub(b);
        if (res.cmpn(0) < 0) {
          res.iadd(this.m);
        }
        return res;
      };
      Red.prototype.shl = function shl(a, num2) {
        this._verify1(a);
        return this.imod(a.ushln(num2));
      };
      Red.prototype.imul = function imul(a, b) {
        this._verify2(a, b);
        return this.imod(a.imul(b));
      };
      Red.prototype.mul = function mul(a, b) {
        this._verify2(a, b);
        return this.imod(a.mul(b));
      };
      Red.prototype.isqr = function isqr(a) {
        return this.imul(a, a.clone());
      };
      Red.prototype.sqr = function sqr(a) {
        return this.mul(a, a);
      };
      Red.prototype.sqrt = function sqrt(a) {
        if (a.isZero()) return a.clone();
        var mod3 = this.m.andln(3);
        assert(mod3 % 2 === 1);
        if (mod3 === 3) {
          var pow = this.m.add(new BN7(1)).iushrn(2);
          return this.pow(a, pow);
        }
        var q = this.m.subn(1);
        var s = 0;
        while (!q.isZero() && q.andln(1) === 0) {
          s++;
          q.iushrn(1);
        }
        assert(!q.isZero());
        var one = new BN7(1).toRed(this);
        var nOne = one.redNeg();
        var lpow = this.m.subn(1).iushrn(1);
        var z = this.m.bitLength();
        z = new BN7(2 * z * z).toRed(this);
        while (this.pow(z, lpow).cmp(nOne) !== 0) {
          z.redIAdd(nOne);
        }
        var c = this.pow(z, q);
        var r = this.pow(a, q.addn(1).iushrn(1));
        var t = this.pow(a, q);
        var m = s;
        while (t.cmp(one) !== 0) {
          var tmp = t;
          for (var i = 0; tmp.cmp(one) !== 0; i++) {
            tmp = tmp.redSqr();
          }
          assert(i < m);
          var b = this.pow(c, new BN7(1).iushln(m - i - 1));
          r = r.redMul(b);
          c = b.redSqr();
          t = t.redMul(c);
          m = i;
        }
        return r;
      };
      Red.prototype.invm = function invm(a) {
        var inv = a._invmp(this.m);
        if (inv.negative !== 0) {
          inv.negative = 0;
          return this.imod(inv).redNeg();
        } else {
          return this.imod(inv);
        }
      };
      Red.prototype.pow = function pow(a, num2) {
        if (num2.isZero()) return new BN7(1).toRed(this);
        if (num2.cmpn(1) === 0) return a.clone();
        var windowSize = 4;
        var wnd = new Array(1 << windowSize);
        wnd[0] = new BN7(1).toRed(this);
        wnd[1] = a;
        for (var i = 2; i < wnd.length; i++) {
          wnd[i] = this.mul(wnd[i - 1], a);
        }
        var res = wnd[0];
        var current = 0;
        var currentLen = 0;
        var start = num2.bitLength() % 26;
        if (start === 0) {
          start = 26;
        }
        for (i = num2.length - 1; i >= 0; i--) {
          var word = num2.words[i];
          for (var j = start - 1; j >= 0; j--) {
            var bit = word >> j & 1;
            if (res !== wnd[0]) {
              res = this.sqr(res);
            }
            if (bit === 0 && current === 0) {
              currentLen = 0;
              continue;
            }
            current <<= 1;
            current |= bit;
            currentLen++;
            if (currentLen !== windowSize && (i !== 0 || j !== 0)) continue;
            res = this.mul(res, wnd[current]);
            currentLen = 0;
            current = 0;
          }
          start = 26;
        }
        return res;
      };
      Red.prototype.convertTo = function convertTo(num2) {
        var r = num2.umod(this.m);
        return r === num2 ? r.clone() : r;
      };
      Red.prototype.convertFrom = function convertFrom(num2) {
        var res = num2.clone();
        res.red = null;
        return res;
      };
      BN7.mont = function mont(num2) {
        return new Mont(num2);
      };
      function Mont(m) {
        Red.call(this, m);
        this.shift = this.m.bitLength();
        if (this.shift % 26 !== 0) {
          this.shift += 26 - this.shift % 26;
        }
        this.r = new BN7(1).iushln(this.shift);
        this.r2 = this.imod(this.r.sqr());
        this.rinv = this.r._invmp(this.m);
        this.minv = this.rinv.mul(this.r).isubn(1).div(this.m);
        this.minv = this.minv.umod(this.r);
        this.minv = this.r.sub(this.minv);
      }
      inherits(Mont, Red);
      Mont.prototype.convertTo = function convertTo(num2) {
        return this.imod(num2.ushln(this.shift));
      };
      Mont.prototype.convertFrom = function convertFrom(num2) {
        var r = this.imod(num2.mul(this.rinv));
        r.red = null;
        return r;
      };
      Mont.prototype.imul = function imul(a, b) {
        if (a.isZero() || b.isZero()) {
          a.words[0] = 0;
          a.length = 1;
          return a;
        }
        var t = a.imul(b);
        var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
        var u = t.isub(c).iushrn(this.shift);
        var res = u;
        if (u.cmp(this.m) >= 0) {
          res = u.isub(this.m);
        } else if (u.cmpn(0) < 0) {
          res = u.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Mont.prototype.mul = function mul(a, b) {
        if (a.isZero() || b.isZero()) return new BN7(0)._forceRed(this);
        var t = a.mul(b);
        var c = t.maskn(this.shift).mul(this.minv).imaskn(this.shift).mul(this.m);
        var u = t.isub(c).iushrn(this.shift);
        var res = u;
        if (u.cmp(this.m) >= 0) {
          res = u.isub(this.m);
        } else if (u.cmpn(0) < 0) {
          res = u.iadd(this.m);
        }
        return res._forceRed(this);
      };
      Mont.prototype.invm = function invm(a) {
        var res = this.imod(a._invmp(this.m).mul(this.r2));
        return res._forceRed(this);
      };
    })(typeof module === "undefined" || module, exports);
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/common.js
var require_common = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/common.js"(exports) {
    "use strict";
    var _a;
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isVersionedTransaction = exports.chunks = exports.isBrowser = void 0;
    exports.isBrowser = process.env.ANCHOR_BROWSER || typeof window !== "undefined" && !((_a = window.process) === null || _a === void 0 ? void 0 : _a.hasOwnProperty("type"));
    function chunks(array, size) {
      return Array.apply(0, new Array(Math.ceil(array.length / size))).map((_, index) => array.slice(index * size, (index + 1) * size));
    }
    exports.chunks = chunks;
    var isVersionedTransaction = (tx) => {
      return "version" in tx;
    };
    exports.isVersionedTransaction = isVersionedTransaction;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/nodewallet.js
var require_nodewallet = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/nodewallet.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var web3_js_1 = __require("@solana/web3.js");
    var common_js_1 = require_common();
    var NodeWallet = class _NodeWallet {
      constructor(payer) {
        this.payer = payer;
      }
      static local() {
        const process2 = __require("process");
        if (!process2.env.ANCHOR_WALLET) {
          throw new Error("expected environment variable `ANCHOR_WALLET` is not set.");
        }
        const payer = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(__require("fs").readFileSync(process2.env.ANCHOR_WALLET, {
          encoding: "utf-8"
        }))));
        return new _NodeWallet(payer);
      }
      async signTransaction(tx) {
        if ((0, common_js_1.isVersionedTransaction)(tx)) {
          tx.sign([this.payer]);
        } else {
          tx.partialSign(this.payer);
        }
        return tx;
      }
      async signAllTransactions(txs) {
        return txs.map((t) => {
          if ((0, common_js_1.isVersionedTransaction)(t)) {
            t.sign([this.payer]);
          } else {
            t.partialSign(this.payer);
          }
          return t;
        });
      }
      get publicKey() {
        return this.payer.publicKey;
      }
    };
    exports.default = NodeWallet;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/hex.js
var require_hex = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/hex.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.decode = exports.encode = void 0;
    var buffer_1 = __require("buffer");
    function encode(data) {
      return data.reduce((str, byte) => str + byte.toString(16).padStart(2, "0"), "0x");
    }
    exports.encode = encode;
    function decode2(data) {
      if (data.indexOf("0x") === 0) {
        data = data.substr(2);
      }
      if (data.length % 2 === 1) {
        data = "0" + data;
      }
      let key2 = data.match(/.{2}/g);
      if (key2 === null) {
        return buffer_1.Buffer.from([]);
      }
      return buffer_1.Buffer.from(key2.map((byte) => parseInt(byte, 16)));
    }
    exports.decode = decode2;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/utf8.js
var require_utf8 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/utf8.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.encode = exports.decode = void 0;
    var common_1 = require_common();
    function decode2(array) {
      const decoder = common_1.isBrowser ? new TextDecoder("utf-8") : new (__require("util")).TextDecoder("utf-8");
      return decoder.decode(array);
    }
    exports.decode = decode2;
    function encode(input) {
      const encoder = common_1.isBrowser ? new TextEncoder() : new (__require("util")).TextEncoder("utf-8");
      return encoder.encode(input);
    }
    exports.encode = encode;
  }
});

// sdk/node_modules/.pnpm/safe-buffer@5.2.1/node_modules/safe-buffer/index.js
var require_safe_buffer = __commonJS({
  "sdk/node_modules/.pnpm/safe-buffer@5.2.1/node_modules/safe-buffer/index.js"(exports, module) {
    var buffer = __require("buffer");
    var Buffer2 = buffer.Buffer;
    function copyProps(src, dst) {
      for (var key2 in src) {
        dst[key2] = src[key2];
      }
    }
    if (Buffer2.from && Buffer2.alloc && Buffer2.allocUnsafe && Buffer2.allocUnsafeSlow) {
      module.exports = buffer;
    } else {
      copyProps(buffer, exports);
      exports.Buffer = SafeBuffer;
    }
    function SafeBuffer(arg, encodingOrOffset, length) {
      return Buffer2(arg, encodingOrOffset, length);
    }
    SafeBuffer.prototype = Object.create(Buffer2.prototype);
    copyProps(Buffer2, SafeBuffer);
    SafeBuffer.from = function(arg, encodingOrOffset, length) {
      if (typeof arg === "number") {
        throw new TypeError("Argument must not be a number");
      }
      return Buffer2(arg, encodingOrOffset, length);
    };
    SafeBuffer.alloc = function(size, fill, encoding) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      var buf = Buffer2(size);
      if (fill !== void 0) {
        if (typeof encoding === "string") {
          buf.fill(fill, encoding);
        } else {
          buf.fill(fill);
        }
      } else {
        buf.fill(0);
      }
      return buf;
    };
    SafeBuffer.allocUnsafe = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return Buffer2(size);
    };
    SafeBuffer.allocUnsafeSlow = function(size) {
      if (typeof size !== "number") {
        throw new TypeError("Argument must be a number");
      }
      return buffer.SlowBuffer(size);
    };
  }
});

// sdk/node_modules/.pnpm/base-x@3.0.11/node_modules/base-x/src/index.js
var require_src = __commonJS({
  "sdk/node_modules/.pnpm/base-x@3.0.11/node_modules/base-x/src/index.js"(exports, module) {
    "use strict";
    var _Buffer = require_safe_buffer().Buffer;
    function base(ALPHABET) {
      if (ALPHABET.length >= 255) {
        throw new TypeError("Alphabet too long");
      }
      var BASE_MAP = new Uint8Array(256);
      for (var j = 0; j < BASE_MAP.length; j++) {
        BASE_MAP[j] = 255;
      }
      for (var i = 0; i < ALPHABET.length; i++) {
        var x = ALPHABET.charAt(i);
        var xc = x.charCodeAt(0);
        if (BASE_MAP[xc] !== 255) {
          throw new TypeError(x + " is ambiguous");
        }
        BASE_MAP[xc] = i;
      }
      var BASE = ALPHABET.length;
      var LEADER = ALPHABET.charAt(0);
      var FACTOR = Math.log(BASE) / Math.log(256);
      var iFACTOR = Math.log(256) / Math.log(BASE);
      function encode(source) {
        if (Array.isArray(source) || source instanceof Uint8Array) {
          source = _Buffer.from(source);
        }
        if (!_Buffer.isBuffer(source)) {
          throw new TypeError("Expected Buffer");
        }
        if (source.length === 0) {
          return "";
        }
        var zeroes = 0;
        var length = 0;
        var pbegin = 0;
        var pend = source.length;
        while (pbegin !== pend && source[pbegin] === 0) {
          pbegin++;
          zeroes++;
        }
        var size = (pend - pbegin) * iFACTOR + 1 >>> 0;
        var b58 = new Uint8Array(size);
        while (pbegin !== pend) {
          var carry = source[pbegin];
          var i2 = 0;
          for (var it1 = size - 1; (carry !== 0 || i2 < length) && it1 !== -1; it1--, i2++) {
            carry += 256 * b58[it1] >>> 0;
            b58[it1] = carry % BASE >>> 0;
            carry = carry / BASE >>> 0;
          }
          if (carry !== 0) {
            throw new Error("Non-zero carry");
          }
          length = i2;
          pbegin++;
        }
        var it2 = size - length;
        while (it2 !== size && b58[it2] === 0) {
          it2++;
        }
        var str = LEADER.repeat(zeroes);
        for (; it2 < size; ++it2) {
          str += ALPHABET.charAt(b58[it2]);
        }
        return str;
      }
      function decodeUnsafe(source) {
        if (typeof source !== "string") {
          throw new TypeError("Expected String");
        }
        if (source.length === 0) {
          return _Buffer.alloc(0);
        }
        var psz = 0;
        var zeroes = 0;
        var length = 0;
        while (source[psz] === LEADER) {
          zeroes++;
          psz++;
        }
        var size = (source.length - psz) * FACTOR + 1 >>> 0;
        var b256 = new Uint8Array(size);
        while (psz < source.length) {
          var charCode = source.charCodeAt(psz);
          if (charCode > 255) {
            return;
          }
          var carry = BASE_MAP[charCode];
          if (carry === 255) {
            return;
          }
          var i2 = 0;
          for (var it3 = size - 1; (carry !== 0 || i2 < length) && it3 !== -1; it3--, i2++) {
            carry += BASE * b256[it3] >>> 0;
            b256[it3] = carry % 256 >>> 0;
            carry = carry / 256 >>> 0;
          }
          if (carry !== 0) {
            throw new Error("Non-zero carry");
          }
          length = i2;
          psz++;
        }
        var it4 = size - length;
        while (it4 !== size && b256[it4] === 0) {
          it4++;
        }
        var vch = _Buffer.allocUnsafe(zeroes + (size - it4));
        vch.fill(0, 0, zeroes);
        var j2 = zeroes;
        while (it4 !== size) {
          vch[j2++] = b256[it4++];
        }
        return vch;
      }
      function decode2(string) {
        var buffer = decodeUnsafe(string);
        if (buffer) {
          return buffer;
        }
        throw new Error("Non-base" + BASE + " character");
      }
      return {
        encode,
        decodeUnsafe,
        decode: decode2
      };
    }
    module.exports = base;
  }
});

// sdk/node_modules/.pnpm/bs58@4.0.1/node_modules/bs58/index.js
var require_bs58 = __commonJS({
  "sdk/node_modules/.pnpm/bs58@4.0.1/node_modules/bs58/index.js"(exports, module) {
    var basex = require_src();
    var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    module.exports = basex(ALPHABET);
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/bs58.js
var require_bs582 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/bs58.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.decode = exports.encode = void 0;
    var bs58_1 = __importDefault(require_bs58());
    function encode(data) {
      return bs58_1.default.encode(data);
    }
    exports.encode = encode;
    function decode2(data) {
      return bs58_1.default.decode(data);
    }
    exports.decode = decode2;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/base64.js
var require_base64 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/base64.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.decode = exports.encode = void 0;
    var buffer_1 = __require("buffer");
    function encode(data) {
      return data.toString("base64");
    }
    exports.encode = encode;
    function decode2(data) {
      return buffer_1.Buffer.from(data, "base64");
    }
    exports.decode = decode2;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/index.js
var require_bytes = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/bytes/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.base64 = exports.bs58 = exports.utf8 = exports.hex = void 0;
    exports.hex = __importStar(require_hex());
    exports.utf8 = __importStar(require_utf8());
    exports.bs58 = __importStar(require_bs582());
    exports.base64 = __importStar(require_base64());
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/trees.js
var require_trees = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/trees.js"(exports, module) {
    "use strict";
    var Z_FIXED = 4;
    var Z_BINARY = 0;
    var Z_TEXT = 1;
    var Z_UNKNOWN = 2;
    function zero(buf) {
      let len = buf.length;
      while (--len >= 0) {
        buf[len] = 0;
      }
    }
    var STORED_BLOCK = 0;
    var STATIC_TREES = 1;
    var DYN_TREES = 2;
    var MIN_MATCH = 3;
    var MAX_MATCH = 258;
    var LENGTH_CODES = 29;
    var LITERALS = 256;
    var L_CODES = LITERALS + 1 + LENGTH_CODES;
    var D_CODES = 30;
    var BL_CODES = 19;
    var HEAP_SIZE = 2 * L_CODES + 1;
    var MAX_BITS = 15;
    var Buf_size = 16;
    var MAX_BL_BITS = 7;
    var END_BLOCK = 256;
    var REP_3_6 = 16;
    var REPZ_3_10 = 17;
    var REPZ_11_138 = 18;
    var extra_lbits = (
      /* extra bits for each length code */
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0])
    );
    var extra_dbits = (
      /* extra bits for each distance code */
      new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13])
    );
    var extra_blbits = (
      /* extra bits for each bit length code */
      new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7])
    );
    var bl_order = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
    var DIST_CODE_LEN = 512;
    var static_ltree = new Array((L_CODES + 2) * 2);
    zero(static_ltree);
    var static_dtree = new Array(D_CODES * 2);
    zero(static_dtree);
    var _dist_code = new Array(DIST_CODE_LEN);
    zero(_dist_code);
    var _length_code = new Array(MAX_MATCH - MIN_MATCH + 1);
    zero(_length_code);
    var base_length = new Array(LENGTH_CODES);
    zero(base_length);
    var base_dist = new Array(D_CODES);
    zero(base_dist);
    function StaticTreeDesc(static_tree, extra_bits, extra_base, elems, max_length) {
      this.static_tree = static_tree;
      this.extra_bits = extra_bits;
      this.extra_base = extra_base;
      this.elems = elems;
      this.max_length = max_length;
      this.has_stree = static_tree && static_tree.length;
    }
    var static_l_desc;
    var static_d_desc;
    var static_bl_desc;
    function TreeDesc(dyn_tree, stat_desc) {
      this.dyn_tree = dyn_tree;
      this.max_code = 0;
      this.stat_desc = stat_desc;
    }
    var d_code = (dist) => {
      return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
    };
    var put_short = (s, w) => {
      s.pending_buf[s.pending++] = w & 255;
      s.pending_buf[s.pending++] = w >>> 8 & 255;
    };
    var send_bits = (s, value, length) => {
      if (s.bi_valid > Buf_size - length) {
        s.bi_buf |= value << s.bi_valid & 65535;
        put_short(s, s.bi_buf);
        s.bi_buf = value >> Buf_size - s.bi_valid;
        s.bi_valid += length - Buf_size;
      } else {
        s.bi_buf |= value << s.bi_valid & 65535;
        s.bi_valid += length;
      }
    };
    var send_code = (s, c, tree) => {
      send_bits(
        s,
        tree[c * 2],
        tree[c * 2 + 1]
        /*.Len*/
      );
    };
    var bi_reverse = (code, len) => {
      let res = 0;
      do {
        res |= code & 1;
        code >>>= 1;
        res <<= 1;
      } while (--len > 0);
      return res >>> 1;
    };
    var bi_flush = (s) => {
      if (s.bi_valid === 16) {
        put_short(s, s.bi_buf);
        s.bi_buf = 0;
        s.bi_valid = 0;
      } else if (s.bi_valid >= 8) {
        s.pending_buf[s.pending++] = s.bi_buf & 255;
        s.bi_buf >>= 8;
        s.bi_valid -= 8;
      }
    };
    var gen_bitlen = (s, desc) => {
      const tree = desc.dyn_tree;
      const max_code = desc.max_code;
      const stree = desc.stat_desc.static_tree;
      const has_stree = desc.stat_desc.has_stree;
      const extra = desc.stat_desc.extra_bits;
      const base = desc.stat_desc.extra_base;
      const max_length = desc.stat_desc.max_length;
      let h;
      let n, m;
      let bits;
      let xbits;
      let f;
      let overflow = 0;
      for (bits = 0; bits <= MAX_BITS; bits++) {
        s.bl_count[bits] = 0;
      }
      tree[s.heap[s.heap_max] * 2 + 1] = 0;
      for (h = s.heap_max + 1; h < HEAP_SIZE; h++) {
        n = s.heap[h];
        bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
        if (bits > max_length) {
          bits = max_length;
          overflow++;
        }
        tree[n * 2 + 1] = bits;
        if (n > max_code) {
          continue;
        }
        s.bl_count[bits]++;
        xbits = 0;
        if (n >= base) {
          xbits = extra[n - base];
        }
        f = tree[n * 2];
        s.opt_len += f * (bits + xbits);
        if (has_stree) {
          s.static_len += f * (stree[n * 2 + 1] + xbits);
        }
      }
      if (overflow === 0) {
        return;
      }
      do {
        bits = max_length - 1;
        while (s.bl_count[bits] === 0) {
          bits--;
        }
        s.bl_count[bits]--;
        s.bl_count[bits + 1] += 2;
        s.bl_count[max_length]--;
        overflow -= 2;
      } while (overflow > 0);
      for (bits = max_length; bits !== 0; bits--) {
        n = s.bl_count[bits];
        while (n !== 0) {
          m = s.heap[--h];
          if (m > max_code) {
            continue;
          }
          if (tree[m * 2 + 1] !== bits) {
            s.opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
            tree[m * 2 + 1] = bits;
          }
          n--;
        }
      }
    };
    var gen_codes = (tree, max_code, bl_count) => {
      const next_code = new Array(MAX_BITS + 1);
      let code = 0;
      let bits;
      let n;
      for (bits = 1; bits <= MAX_BITS; bits++) {
        code = code + bl_count[bits - 1] << 1;
        next_code[bits] = code;
      }
      for (n = 0; n <= max_code; n++) {
        let len = tree[n * 2 + 1];
        if (len === 0) {
          continue;
        }
        tree[n * 2] = bi_reverse(next_code[len]++, len);
      }
    };
    var tr_static_init = () => {
      let n;
      let bits;
      let length;
      let code;
      let dist;
      const bl_count = new Array(MAX_BITS + 1);
      length = 0;
      for (code = 0; code < LENGTH_CODES - 1; code++) {
        base_length[code] = length;
        for (n = 0; n < 1 << extra_lbits[code]; n++) {
          _length_code[length++] = code;
        }
      }
      _length_code[length - 1] = code;
      dist = 0;
      for (code = 0; code < 16; code++) {
        base_dist[code] = dist;
        for (n = 0; n < 1 << extra_dbits[code]; n++) {
          _dist_code[dist++] = code;
        }
      }
      dist >>= 7;
      for (; code < D_CODES; code++) {
        base_dist[code] = dist << 7;
        for (n = 0; n < 1 << extra_dbits[code] - 7; n++) {
          _dist_code[256 + dist++] = code;
        }
      }
      for (bits = 0; bits <= MAX_BITS; bits++) {
        bl_count[bits] = 0;
      }
      n = 0;
      while (n <= 143) {
        static_ltree[n * 2 + 1] = 8;
        n++;
        bl_count[8]++;
      }
      while (n <= 255) {
        static_ltree[n * 2 + 1] = 9;
        n++;
        bl_count[9]++;
      }
      while (n <= 279) {
        static_ltree[n * 2 + 1] = 7;
        n++;
        bl_count[7]++;
      }
      while (n <= 287) {
        static_ltree[n * 2 + 1] = 8;
        n++;
        bl_count[8]++;
      }
      gen_codes(static_ltree, L_CODES + 1, bl_count);
      for (n = 0; n < D_CODES; n++) {
        static_dtree[n * 2 + 1] = 5;
        static_dtree[n * 2] = bi_reverse(n, 5);
      }
      static_l_desc = new StaticTreeDesc(static_ltree, extra_lbits, LITERALS + 1, L_CODES, MAX_BITS);
      static_d_desc = new StaticTreeDesc(static_dtree, extra_dbits, 0, D_CODES, MAX_BITS);
      static_bl_desc = new StaticTreeDesc(new Array(0), extra_blbits, 0, BL_CODES, MAX_BL_BITS);
    };
    var init_block = (s) => {
      let n;
      for (n = 0; n < L_CODES; n++) {
        s.dyn_ltree[n * 2] = 0;
      }
      for (n = 0; n < D_CODES; n++) {
        s.dyn_dtree[n * 2] = 0;
      }
      for (n = 0; n < BL_CODES; n++) {
        s.bl_tree[n * 2] = 0;
      }
      s.dyn_ltree[END_BLOCK * 2] = 1;
      s.opt_len = s.static_len = 0;
      s.sym_next = s.matches = 0;
    };
    var bi_windup = (s) => {
      if (s.bi_valid > 8) {
        put_short(s, s.bi_buf);
      } else if (s.bi_valid > 0) {
        s.pending_buf[s.pending++] = s.bi_buf;
      }
      s.bi_buf = 0;
      s.bi_valid = 0;
    };
    var smaller = (tree, n, m, depth) => {
      const _n2 = n * 2;
      const _m2 = m * 2;
      return tree[_n2] < tree[_m2] || tree[_n2] === tree[_m2] && depth[n] <= depth[m];
    };
    var pqdownheap = (s, tree, k) => {
      const v = s.heap[k];
      let j = k << 1;
      while (j <= s.heap_len) {
        if (j < s.heap_len && smaller(tree, s.heap[j + 1], s.heap[j], s.depth)) {
          j++;
        }
        if (smaller(tree, v, s.heap[j], s.depth)) {
          break;
        }
        s.heap[k] = s.heap[j];
        k = j;
        j <<= 1;
      }
      s.heap[k] = v;
    };
    var compress_block = (s, ltree, dtree) => {
      let dist;
      let lc;
      let sx = 0;
      let code;
      let extra;
      if (s.sym_next !== 0) {
        do {
          dist = s.pending_buf[s.sym_buf + sx++] & 255;
          dist += (s.pending_buf[s.sym_buf + sx++] & 255) << 8;
          lc = s.pending_buf[s.sym_buf + sx++];
          if (dist === 0) {
            send_code(s, lc, ltree);
          } else {
            code = _length_code[lc];
            send_code(s, code + LITERALS + 1, ltree);
            extra = extra_lbits[code];
            if (extra !== 0) {
              lc -= base_length[code];
              send_bits(s, lc, extra);
            }
            dist--;
            code = d_code(dist);
            send_code(s, code, dtree);
            extra = extra_dbits[code];
            if (extra !== 0) {
              dist -= base_dist[code];
              send_bits(s, dist, extra);
            }
          }
        } while (sx < s.sym_next);
      }
      send_code(s, END_BLOCK, ltree);
    };
    var build_tree = (s, desc) => {
      const tree = desc.dyn_tree;
      const stree = desc.stat_desc.static_tree;
      const has_stree = desc.stat_desc.has_stree;
      const elems = desc.stat_desc.elems;
      let n, m;
      let max_code = -1;
      let node;
      s.heap_len = 0;
      s.heap_max = HEAP_SIZE;
      for (n = 0; n < elems; n++) {
        if (tree[n * 2] !== 0) {
          s.heap[++s.heap_len] = max_code = n;
          s.depth[n] = 0;
        } else {
          tree[n * 2 + 1] = 0;
        }
      }
      while (s.heap_len < 2) {
        node = s.heap[++s.heap_len] = max_code < 2 ? ++max_code : 0;
        tree[node * 2] = 1;
        s.depth[node] = 0;
        s.opt_len--;
        if (has_stree) {
          s.static_len -= stree[node * 2 + 1];
        }
      }
      desc.max_code = max_code;
      for (n = s.heap_len >> 1; n >= 1; n--) {
        pqdownheap(s, tree, n);
      }
      node = elems;
      do {
        n = s.heap[
          1
          /*SMALLEST*/
        ];
        s.heap[
          1
          /*SMALLEST*/
        ] = s.heap[s.heap_len--];
        pqdownheap(
          s,
          tree,
          1
          /*SMALLEST*/
        );
        m = s.heap[
          1
          /*SMALLEST*/
        ];
        s.heap[--s.heap_max] = n;
        s.heap[--s.heap_max] = m;
        tree[node * 2] = tree[n * 2] + tree[m * 2];
        s.depth[node] = (s.depth[n] >= s.depth[m] ? s.depth[n] : s.depth[m]) + 1;
        tree[n * 2 + 1] = tree[m * 2 + 1] = node;
        s.heap[
          1
          /*SMALLEST*/
        ] = node++;
        pqdownheap(
          s,
          tree,
          1
          /*SMALLEST*/
        );
      } while (s.heap_len >= 2);
      s.heap[--s.heap_max] = s.heap[
        1
        /*SMALLEST*/
      ];
      gen_bitlen(s, desc);
      gen_codes(tree, max_code, s.bl_count);
    };
    var scan_tree = (s, tree, max_code) => {
      let n;
      let prevlen = -1;
      let curlen;
      let nextlen = tree[0 * 2 + 1];
      let count = 0;
      let max_count = 7;
      let min_count = 4;
      if (nextlen === 0) {
        max_count = 138;
        min_count = 3;
      }
      tree[(max_code + 1) * 2 + 1] = 65535;
      for (n = 0; n <= max_code; n++) {
        curlen = nextlen;
        nextlen = tree[(n + 1) * 2 + 1];
        if (++count < max_count && curlen === nextlen) {
          continue;
        } else if (count < min_count) {
          s.bl_tree[curlen * 2] += count;
        } else if (curlen !== 0) {
          if (curlen !== prevlen) {
            s.bl_tree[curlen * 2]++;
          }
          s.bl_tree[REP_3_6 * 2]++;
        } else if (count <= 10) {
          s.bl_tree[REPZ_3_10 * 2]++;
        } else {
          s.bl_tree[REPZ_11_138 * 2]++;
        }
        count = 0;
        prevlen = curlen;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        } else if (curlen === nextlen) {
          max_count = 6;
          min_count = 3;
        } else {
          max_count = 7;
          min_count = 4;
        }
      }
    };
    var send_tree = (s, tree, max_code) => {
      let n;
      let prevlen = -1;
      let curlen;
      let nextlen = tree[0 * 2 + 1];
      let count = 0;
      let max_count = 7;
      let min_count = 4;
      if (nextlen === 0) {
        max_count = 138;
        min_count = 3;
      }
      for (n = 0; n <= max_code; n++) {
        curlen = nextlen;
        nextlen = tree[(n + 1) * 2 + 1];
        if (++count < max_count && curlen === nextlen) {
          continue;
        } else if (count < min_count) {
          do {
            send_code(s, curlen, s.bl_tree);
          } while (--count !== 0);
        } else if (curlen !== 0) {
          if (curlen !== prevlen) {
            send_code(s, curlen, s.bl_tree);
            count--;
          }
          send_code(s, REP_3_6, s.bl_tree);
          send_bits(s, count - 3, 2);
        } else if (count <= 10) {
          send_code(s, REPZ_3_10, s.bl_tree);
          send_bits(s, count - 3, 3);
        } else {
          send_code(s, REPZ_11_138, s.bl_tree);
          send_bits(s, count - 11, 7);
        }
        count = 0;
        prevlen = curlen;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        } else if (curlen === nextlen) {
          max_count = 6;
          min_count = 3;
        } else {
          max_count = 7;
          min_count = 4;
        }
      }
    };
    var build_bl_tree = (s) => {
      let max_blindex;
      scan_tree(s, s.dyn_ltree, s.l_desc.max_code);
      scan_tree(s, s.dyn_dtree, s.d_desc.max_code);
      build_tree(s, s.bl_desc);
      for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) {
        if (s.bl_tree[bl_order[max_blindex] * 2 + 1] !== 0) {
          break;
        }
      }
      s.opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
      return max_blindex;
    };
    var send_all_trees = (s, lcodes, dcodes, blcodes) => {
      let rank;
      send_bits(s, lcodes - 257, 5);
      send_bits(s, dcodes - 1, 5);
      send_bits(s, blcodes - 4, 4);
      for (rank = 0; rank < blcodes; rank++) {
        send_bits(s, s.bl_tree[bl_order[rank] * 2 + 1], 3);
      }
      send_tree(s, s.dyn_ltree, lcodes - 1);
      send_tree(s, s.dyn_dtree, dcodes - 1);
    };
    var detect_data_type = (s) => {
      let block_mask = 4093624447;
      let n;
      for (n = 0; n <= 31; n++, block_mask >>>= 1) {
        if (block_mask & 1 && s.dyn_ltree[n * 2] !== 0) {
          return Z_BINARY;
        }
      }
      if (s.dyn_ltree[9 * 2] !== 0 || s.dyn_ltree[10 * 2] !== 0 || s.dyn_ltree[13 * 2] !== 0) {
        return Z_TEXT;
      }
      for (n = 32; n < LITERALS; n++) {
        if (s.dyn_ltree[n * 2] !== 0) {
          return Z_TEXT;
        }
      }
      return Z_BINARY;
    };
    var static_init_done = false;
    var _tr_init = (s) => {
      if (!static_init_done) {
        tr_static_init();
        static_init_done = true;
      }
      s.l_desc = new TreeDesc(s.dyn_ltree, static_l_desc);
      s.d_desc = new TreeDesc(s.dyn_dtree, static_d_desc);
      s.bl_desc = new TreeDesc(s.bl_tree, static_bl_desc);
      s.bi_buf = 0;
      s.bi_valid = 0;
      init_block(s);
    };
    var _tr_stored_block = (s, buf, stored_len, last) => {
      send_bits(s, (STORED_BLOCK << 1) + (last ? 1 : 0), 3);
      bi_windup(s);
      put_short(s, stored_len);
      put_short(s, ~stored_len);
      if (stored_len) {
        s.pending_buf.set(s.window.subarray(buf, buf + stored_len), s.pending);
      }
      s.pending += stored_len;
    };
    var _tr_align = (s) => {
      send_bits(s, STATIC_TREES << 1, 3);
      send_code(s, END_BLOCK, static_ltree);
      bi_flush(s);
    };
    var _tr_flush_block = (s, buf, stored_len, last) => {
      let opt_lenb, static_lenb;
      let max_blindex = 0;
      if (s.level > 0) {
        if (s.strm.data_type === Z_UNKNOWN) {
          s.strm.data_type = detect_data_type(s);
        }
        build_tree(s, s.l_desc);
        build_tree(s, s.d_desc);
        max_blindex = build_bl_tree(s);
        opt_lenb = s.opt_len + 3 + 7 >>> 3;
        static_lenb = s.static_len + 3 + 7 >>> 3;
        if (static_lenb <= opt_lenb) {
          opt_lenb = static_lenb;
        }
      } else {
        opt_lenb = static_lenb = stored_len + 5;
      }
      if (stored_len + 4 <= opt_lenb && buf !== -1) {
        _tr_stored_block(s, buf, stored_len, last);
      } else if (s.strategy === Z_FIXED || static_lenb === opt_lenb) {
        send_bits(s, (STATIC_TREES << 1) + (last ? 1 : 0), 3);
        compress_block(s, static_ltree, static_dtree);
      } else {
        send_bits(s, (DYN_TREES << 1) + (last ? 1 : 0), 3);
        send_all_trees(s, s.l_desc.max_code + 1, s.d_desc.max_code + 1, max_blindex + 1);
        compress_block(s, s.dyn_ltree, s.dyn_dtree);
      }
      init_block(s);
      if (last) {
        bi_windup(s);
      }
    };
    var _tr_tally = (s, dist, lc) => {
      s.pending_buf[s.sym_buf + s.sym_next++] = dist;
      s.pending_buf[s.sym_buf + s.sym_next++] = dist >> 8;
      s.pending_buf[s.sym_buf + s.sym_next++] = lc;
      if (dist === 0) {
        s.dyn_ltree[lc * 2]++;
      } else {
        s.matches++;
        dist--;
        s.dyn_ltree[(_length_code[lc] + LITERALS + 1) * 2]++;
        s.dyn_dtree[d_code(dist) * 2]++;
      }
      return s.sym_next === s.sym_end;
    };
    module.exports._tr_init = _tr_init;
    module.exports._tr_stored_block = _tr_stored_block;
    module.exports._tr_flush_block = _tr_flush_block;
    module.exports._tr_tally = _tr_tally;
    module.exports._tr_align = _tr_align;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/adler32.js
var require_adler32 = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/adler32.js"(exports, module) {
    "use strict";
    var adler32 = (adler, buf, len, pos) => {
      let s1 = adler & 65535 | 0, s2 = adler >>> 16 & 65535 | 0, n = 0;
      while (len !== 0) {
        n = len > 2e3 ? 2e3 : len;
        len -= n;
        do {
          s1 = s1 + buf[pos++] | 0;
          s2 = s2 + s1 | 0;
        } while (--n);
        s1 %= 65521;
        s2 %= 65521;
      }
      return s1 | s2 << 16 | 0;
    };
    module.exports = adler32;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/crc32.js
var require_crc32 = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/crc32.js"(exports, module) {
    "use strict";
    var makeTable = () => {
      let c, table2 = [];
      for (var n = 0; n < 256; n++) {
        c = n;
        for (var k = 0; k < 8; k++) {
          c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
        }
        table2[n] = c;
      }
      return table2;
    };
    var crcTable = new Uint32Array(makeTable());
    var crc32 = (crc, buf, len, pos) => {
      const t = crcTable;
      const end = pos + len;
      crc ^= -1;
      for (let i = pos; i < end; i++) {
        crc = crc >>> 8 ^ t[(crc ^ buf[i]) & 255];
      }
      return crc ^ -1;
    };
    module.exports = crc32;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/messages.js
var require_messages = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/messages.js"(exports, module) {
    "use strict";
    module.exports = {
      2: "need dictionary",
      /* Z_NEED_DICT       2  */
      1: "stream end",
      /* Z_STREAM_END      1  */
      0: "",
      /* Z_OK              0  */
      "-1": "file error",
      /* Z_ERRNO         (-1) */
      "-2": "stream error",
      /* Z_STREAM_ERROR  (-2) */
      "-3": "data error",
      /* Z_DATA_ERROR    (-3) */
      "-4": "insufficient memory",
      /* Z_MEM_ERROR     (-4) */
      "-5": "buffer error",
      /* Z_BUF_ERROR     (-5) */
      "-6": "incompatible version"
      /* Z_VERSION_ERROR (-6) */
    };
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/constants.js
var require_constants = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/constants.js"(exports, module) {
    "use strict";
    module.exports = {
      /* Allowed flush values; see deflate() and inflate() below for details */
      Z_NO_FLUSH: 0,
      Z_PARTIAL_FLUSH: 1,
      Z_SYNC_FLUSH: 2,
      Z_FULL_FLUSH: 3,
      Z_FINISH: 4,
      Z_BLOCK: 5,
      Z_TREES: 6,
      /* Return codes for the compression/decompression functions. Negative values
      * are errors, positive values are used for special but normal events.
      */
      Z_OK: 0,
      Z_STREAM_END: 1,
      Z_NEED_DICT: 2,
      Z_ERRNO: -1,
      Z_STREAM_ERROR: -2,
      Z_DATA_ERROR: -3,
      Z_MEM_ERROR: -4,
      Z_BUF_ERROR: -5,
      //Z_VERSION_ERROR: -6,
      /* compression levels */
      Z_NO_COMPRESSION: 0,
      Z_BEST_SPEED: 1,
      Z_BEST_COMPRESSION: 9,
      Z_DEFAULT_COMPRESSION: -1,
      Z_FILTERED: 1,
      Z_HUFFMAN_ONLY: 2,
      Z_RLE: 3,
      Z_FIXED: 4,
      Z_DEFAULT_STRATEGY: 0,
      /* Possible values of the data_type field (though see inflate()) */
      Z_BINARY: 0,
      Z_TEXT: 1,
      //Z_ASCII:                1, // = Z_TEXT (deprecated)
      Z_UNKNOWN: 2,
      /* The deflate compression method */
      Z_DEFLATED: 8
      //Z_NULL:                 null // Use -1 or null inline, depending on var type
    };
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/deflate.js
var require_deflate = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/deflate.js"(exports, module) {
    "use strict";
    var { _tr_init, _tr_stored_block, _tr_flush_block, _tr_tally, _tr_align } = require_trees();
    var adler32 = require_adler32();
    var crc32 = require_crc32();
    var msg = require_messages();
    var {
      Z_NO_FLUSH,
      Z_PARTIAL_FLUSH,
      Z_FULL_FLUSH,
      Z_FINISH,
      Z_BLOCK,
      Z_OK,
      Z_STREAM_END,
      Z_STREAM_ERROR,
      Z_DATA_ERROR,
      Z_BUF_ERROR,
      Z_DEFAULT_COMPRESSION,
      Z_FILTERED,
      Z_HUFFMAN_ONLY,
      Z_RLE,
      Z_FIXED,
      Z_DEFAULT_STRATEGY,
      Z_UNKNOWN,
      Z_DEFLATED
    } = require_constants();
    var MAX_MEM_LEVEL = 9;
    var MAX_WBITS = 15;
    var DEF_MEM_LEVEL = 8;
    var LENGTH_CODES = 29;
    var LITERALS = 256;
    var L_CODES = LITERALS + 1 + LENGTH_CODES;
    var D_CODES = 30;
    var BL_CODES = 19;
    var HEAP_SIZE = 2 * L_CODES + 1;
    var MAX_BITS = 15;
    var MIN_MATCH = 3;
    var MAX_MATCH = 258;
    var MIN_LOOKAHEAD = MAX_MATCH + MIN_MATCH + 1;
    var PRESET_DICT = 32;
    var INIT_STATE = 42;
    var GZIP_STATE = 57;
    var EXTRA_STATE = 69;
    var NAME_STATE = 73;
    var COMMENT_STATE = 91;
    var HCRC_STATE = 103;
    var BUSY_STATE = 113;
    var FINISH_STATE = 666;
    var BS_NEED_MORE = 1;
    var BS_BLOCK_DONE = 2;
    var BS_FINISH_STARTED = 3;
    var BS_FINISH_DONE = 4;
    var OS_CODE = 3;
    var err = (strm, errorCode) => {
      strm.msg = msg[errorCode];
      return errorCode;
    };
    var rank = (f) => {
      return f * 2 - (f > 4 ? 9 : 0);
    };
    var zero = (buf) => {
      let len = buf.length;
      while (--len >= 0) {
        buf[len] = 0;
      }
    };
    var slide_hash = (s) => {
      let n, m;
      let p;
      let wsize = s.w_size;
      n = s.hash_size;
      p = n;
      do {
        m = s.head[--p];
        s.head[p] = m >= wsize ? m - wsize : 0;
      } while (--n);
      n = wsize;
      p = n;
      do {
        m = s.prev[--p];
        s.prev[p] = m >= wsize ? m - wsize : 0;
      } while (--n);
    };
    var HASH = (s, prev, data) => (prev << s.hash_shift ^ data) & s.hash_mask;
    var INSERT_STRING = (s, str) => {
      let h;
      if (s.legacy_hash) {
        h = s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
      } else {
        const w = s.window;
        const value = w[str] | w[str + 1] << 8 | w[str + 2] << 16 | w[str + 3] << 24;
        h = s.ins_h = Math.imul(value, 66521) + 66521 >>> 16 & s.hash_mask;
      }
      const hash_head = s.prev[str & s.w_mask] = s.head[h];
      s.head[h] = str;
      return hash_head;
    };
    var flush_pending = (strm) => {
      const s = strm.state;
      let len = s.pending;
      if (len > strm.avail_out) {
        len = strm.avail_out;
      }
      if (len === 0) {
        return;
      }
      strm.output.set(s.pending_buf.subarray(s.pending_out, s.pending_out + len), strm.next_out);
      strm.next_out += len;
      s.pending_out += len;
      strm.total_out += len;
      strm.avail_out -= len;
      s.pending -= len;
      if (s.pending === 0) {
        s.pending_out = 0;
      }
    };
    var flush_block_only = (s, last) => {
      _tr_flush_block(s, s.block_start >= 0 ? s.block_start : -1, s.strstart - s.block_start, last);
      s.block_start = s.strstart;
      flush_pending(s.strm);
    };
    var put_byte = (s, b) => {
      s.pending_buf[s.pending++] = b;
    };
    var putShortMSB = (s, b) => {
      s.pending_buf[s.pending++] = b >>> 8 & 255;
      s.pending_buf[s.pending++] = b & 255;
    };
    var read_buf = (strm, buf, start, size) => {
      let len = strm.avail_in;
      if (len > size) {
        len = size;
      }
      if (len === 0) {
        return 0;
      }
      strm.avail_in -= len;
      buf.set(strm.input.subarray(strm.next_in, strm.next_in + len), start);
      if (strm.state.wrap === 1) {
        strm.adler = adler32(strm.adler, buf, len, start);
      } else if (strm.state.wrap === 2) {
        strm.adler = crc32(strm.adler, buf, len, start);
      }
      strm.next_in += len;
      strm.total_in += len;
      return len;
    };
    var longest_match = (s, cur_match) => {
      let chain_length = s.max_chain_length;
      let scan = s.strstart;
      let match;
      let len;
      let best_len = s.prev_length;
      let nice_match = s.nice_match;
      const limit = s.strstart > s.w_size - MIN_LOOKAHEAD ? s.strstart - (s.w_size - MIN_LOOKAHEAD) : 0;
      const _win = s.window;
      const wmask = s.w_mask;
      const prev = s.prev;
      const strend = s.strstart + MAX_MATCH;
      let scan_end1 = _win[scan + best_len - 1];
      let scan_end = _win[scan + best_len];
      if (s.prev_length >= s.good_match) {
        chain_length >>= 2;
      }
      if (nice_match > s.lookahead) {
        nice_match = s.lookahead;
      }
      do {
        match = cur_match;
        if (_win[match + best_len] !== scan_end || _win[match + best_len - 1] !== scan_end1 || _win[match] !== _win[scan] || _win[++match] !== _win[scan + 1]) {
          continue;
        }
        scan += 2;
        match++;
        do {
        } while (_win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && scan < strend);
        len = MAX_MATCH - (strend - scan);
        scan = strend - MAX_MATCH;
        if (len > best_len) {
          s.match_start = cur_match;
          best_len = len;
          if (len >= nice_match) {
            break;
          }
          scan_end1 = _win[scan + best_len - 1];
          scan_end = _win[scan + best_len];
        }
      } while ((cur_match = prev[cur_match & wmask]) > limit && --chain_length !== 0);
      if (best_len <= s.lookahead) {
        return best_len;
      }
      return s.lookahead;
    };
    var fill_window = (s) => {
      const _w_size = s.w_size;
      let n, more, str;
      do {
        more = s.window_size - s.lookahead - s.strstart;
        if (s.strstart >= _w_size + (_w_size - MIN_LOOKAHEAD)) {
          s.window.set(s.window.subarray(_w_size, _w_size + _w_size - more), 0);
          s.match_start -= _w_size;
          s.strstart -= _w_size;
          s.block_start -= _w_size;
          if (s.insert > s.strstart) {
            s.insert = s.strstart;
          }
          slide_hash(s);
          more += _w_size;
        }
        if (s.strm.avail_in === 0) {
          break;
        }
        n = read_buf(s.strm, s.window, s.strstart + s.lookahead, more);
        s.lookahead += n;
        if (!s.legacy_hash) {
          if (s.lookahead + s.insert > MIN_MATCH) {
            str = s.strstart - s.insert;
            while (s.insert) {
              INSERT_STRING(s, str);
              str++;
              s.insert--;
              if (s.lookahead + s.insert <= MIN_MATCH) {
                break;
              }
            }
          }
        } else if (s.lookahead + s.insert >= MIN_MATCH) {
          str = s.strstart - s.insert;
          s.ins_h = s.window[str];
          s.ins_h = HASH(s, s.ins_h, s.window[str + 1]);
          while (s.insert) {
            INSERT_STRING(s, str);
            str++;
            s.insert--;
            if (s.lookahead + s.insert < MIN_MATCH) {
              break;
            }
          }
        }
      } while (s.lookahead < MIN_LOOKAHEAD && s.strm.avail_in !== 0);
    };
    var deflate_stored = (s, flush) => {
      let min_block = s.pending_buf_size - 5 > s.w_size ? s.w_size : s.pending_buf_size - 5;
      let len, left, have, last = 0;
      let used = s.strm.avail_in;
      do {
        len = 65535;
        have = s.bi_valid + 42 >> 3;
        if (s.strm.avail_out < have) {
          break;
        }
        have = s.strm.avail_out - have;
        left = s.strstart - s.block_start;
        if (len > left + s.strm.avail_in) {
          len = left + s.strm.avail_in;
        }
        if (len > have) {
          len = have;
        }
        if (len < min_block && (len === 0 && flush !== Z_FINISH || flush === Z_NO_FLUSH || len !== left + s.strm.avail_in)) {
          break;
        }
        last = flush === Z_FINISH && len === left + s.strm.avail_in ? 1 : 0;
        _tr_stored_block(s, 0, 0, last);
        s.pending_buf[s.pending - 4] = len;
        s.pending_buf[s.pending - 3] = len >> 8;
        s.pending_buf[s.pending - 2] = ~len;
        s.pending_buf[s.pending - 1] = ~len >> 8;
        flush_pending(s.strm);
        if (left) {
          if (left > len) {
            left = len;
          }
          s.strm.output.set(s.window.subarray(s.block_start, s.block_start + left), s.strm.next_out);
          s.strm.next_out += left;
          s.strm.avail_out -= left;
          s.strm.total_out += left;
          s.block_start += left;
          len -= left;
        }
        if (len) {
          read_buf(s.strm, s.strm.output, s.strm.next_out, len);
          s.strm.next_out += len;
          s.strm.avail_out -= len;
          s.strm.total_out += len;
        }
      } while (last === 0);
      used -= s.strm.avail_in;
      if (used) {
        if (used >= s.w_size) {
          s.matches = 2;
          s.window.set(s.strm.input.subarray(s.strm.next_in - s.w_size, s.strm.next_in), 0);
          s.strstart = s.w_size;
          s.insert = s.strstart;
        } else {
          if (s.window_size - s.strstart <= used) {
            s.strstart -= s.w_size;
            s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
            if (s.matches < 2) {
              s.matches++;
            }
            if (s.insert > s.strstart) {
              s.insert = s.strstart;
            }
          }
          s.window.set(s.strm.input.subarray(s.strm.next_in - used, s.strm.next_in), s.strstart);
          s.strstart += used;
          s.insert += used > s.w_size - s.insert ? s.w_size - s.insert : used;
        }
        s.block_start = s.strstart;
      }
      if (s.high_water < s.strstart) {
        s.high_water = s.strstart;
      }
      if (last) {
        return BS_FINISH_DONE;
      }
      if (flush !== Z_NO_FLUSH && flush !== Z_FINISH && s.strm.avail_in === 0 && s.strstart === s.block_start) {
        return BS_BLOCK_DONE;
      }
      have = s.window_size - s.strstart;
      if (s.strm.avail_in > have && s.block_start >= s.w_size) {
        s.block_start -= s.w_size;
        s.strstart -= s.w_size;
        s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
        if (s.matches < 2) {
          s.matches++;
        }
        have += s.w_size;
        if (s.insert > s.strstart) {
          s.insert = s.strstart;
        }
      }
      if (have > s.strm.avail_in) {
        have = s.strm.avail_in;
      }
      if (have) {
        read_buf(s.strm, s.window, s.strstart, have);
        s.strstart += have;
        s.insert += have > s.w_size - s.insert ? s.w_size - s.insert : have;
      }
      if (s.high_water < s.strstart) {
        s.high_water = s.strstart;
      }
      have = s.bi_valid + 42 >> 3;
      have = s.pending_buf_size - have > 65535 ? 65535 : s.pending_buf_size - have;
      min_block = have > s.w_size ? s.w_size : have;
      left = s.strstart - s.block_start;
      if (left >= min_block || (left || flush === Z_FINISH) && flush !== Z_NO_FLUSH && s.strm.avail_in === 0 && left <= have) {
        len = left > have ? have : left;
        last = flush === Z_FINISH && s.strm.avail_in === 0 && len === left ? 1 : 0;
        _tr_stored_block(s, s.block_start, len, last);
        s.block_start += len;
        flush_pending(s.strm);
      }
      return last ? BS_FINISH_STARTED : BS_NEED_MORE;
    };
    var deflate_fast = (s, flush) => {
      let hash_head;
      let bflush;
      for (; ; ) {
        if (s.lookahead < MIN_LOOKAHEAD) {
          fill_window(s);
          if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH) {
            return BS_NEED_MORE;
          }
          if (s.lookahead === 0) {
            break;
          }
        }
        hash_head = 0;
        if (s.lookahead >= MIN_MATCH) {
          hash_head = INSERT_STRING(s, s.strstart);
        }
        if (hash_head !== 0 && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
          s.match_length = longest_match(s, hash_head);
        }
        if (s.match_length >= MIN_MATCH) {
          bflush = _tr_tally(s, s.strstart - s.match_start, s.match_length - MIN_MATCH);
          s.lookahead -= s.match_length;
          if (s.match_length <= s.max_lazy_match && s.lookahead >= MIN_MATCH) {
            s.match_length--;
            do {
              s.strstart++;
              hash_head = INSERT_STRING(s, s.strstart);
            } while (--s.match_length !== 0);
            s.strstart++;
          } else {
            s.strstart += s.match_length;
            s.match_length = 0;
            if (s.legacy_hash) {
              s.ins_h = s.window[s.strstart];
              s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + 1]);
            }
          }
        } else {
          bflush = _tr_tally(s, 0, s.window[s.strstart]);
          s.lookahead--;
          s.strstart++;
        }
        if (bflush) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
      }
      s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
      if (flush === Z_FINISH) {
        flush_block_only(s, true);
        if (s.strm.avail_out === 0) {
          return BS_FINISH_STARTED;
        }
        return BS_FINISH_DONE;
      }
      if (s.sym_next) {
        flush_block_only(s, false);
        if (s.strm.avail_out === 0) {
          return BS_NEED_MORE;
        }
      }
      return BS_BLOCK_DONE;
    };
    var deflate_slow = (s, flush) => {
      let hash_head;
      let bflush;
      let max_insert;
      for (; ; ) {
        if (s.lookahead < MIN_LOOKAHEAD) {
          fill_window(s);
          if (s.lookahead < MIN_LOOKAHEAD && flush === Z_NO_FLUSH) {
            return BS_NEED_MORE;
          }
          if (s.lookahead === 0) {
            break;
          }
        }
        hash_head = 0;
        if (s.lookahead >= MIN_MATCH) {
          hash_head = INSERT_STRING(s, s.strstart);
        }
        s.prev_length = s.match_length;
        s.prev_match = s.match_start;
        s.match_length = MIN_MATCH - 1;
        if (hash_head !== 0 && s.prev_length < s.max_lazy_match && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
          s.match_length = longest_match(s, hash_head);
          if (s.match_length <= 5 && (s.strategy === Z_FILTERED || s.match_length === MIN_MATCH && s.strstart - s.match_start > 4096)) {
            s.match_length = MIN_MATCH - 1;
          }
        }
        if (s.prev_length >= MIN_MATCH && s.match_length <= s.prev_length) {
          max_insert = s.strstart + s.lookahead - MIN_MATCH;
          bflush = _tr_tally(s, s.strstart - 1 - s.prev_match, s.prev_length - MIN_MATCH);
          s.lookahead -= s.prev_length - 1;
          s.prev_length -= 2;
          do {
            if (++s.strstart <= max_insert) {
              hash_head = INSERT_STRING(s, s.strstart);
            }
          } while (--s.prev_length !== 0);
          s.match_available = 0;
          s.match_length = MIN_MATCH - 1;
          s.strstart++;
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) {
              return BS_NEED_MORE;
            }
          }
        } else if (s.match_available) {
          bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
          if (bflush) {
            flush_block_only(s, false);
          }
          s.strstart++;
          s.lookahead--;
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        } else {
          s.match_available = 1;
          s.strstart++;
          s.lookahead--;
        }
      }
      if (s.match_available) {
        bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
        s.match_available = 0;
      }
      s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
      if (flush === Z_FINISH) {
        flush_block_only(s, true);
        if (s.strm.avail_out === 0) {
          return BS_FINISH_STARTED;
        }
        return BS_FINISH_DONE;
      }
      if (s.sym_next) {
        flush_block_only(s, false);
        if (s.strm.avail_out === 0) {
          return BS_NEED_MORE;
        }
      }
      return BS_BLOCK_DONE;
    };
    var deflate_rle = (s, flush) => {
      let bflush;
      let prev;
      let scan, strend;
      const _win = s.window;
      for (; ; ) {
        if (s.lookahead <= MAX_MATCH) {
          fill_window(s);
          if (s.lookahead <= MAX_MATCH && flush === Z_NO_FLUSH) {
            return BS_NEED_MORE;
          }
          if (s.lookahead === 0) {
            break;
          }
        }
        s.match_length = 0;
        if (s.lookahead >= MIN_MATCH && s.strstart > 0) {
          scan = s.strstart - 1;
          prev = _win[scan];
          if (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan]) {
            strend = s.strstart + MAX_MATCH;
            do {
            } while (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && scan < strend);
            s.match_length = MAX_MATCH - (strend - scan);
            if (s.match_length > s.lookahead) {
              s.match_length = s.lookahead;
            }
          }
        }
        if (s.match_length >= MIN_MATCH) {
          bflush = _tr_tally(s, 1, s.match_length - MIN_MATCH);
          s.lookahead -= s.match_length;
          s.strstart += s.match_length;
          s.match_length = 0;
        } else {
          bflush = _tr_tally(s, 0, s.window[s.strstart]);
          s.lookahead--;
          s.strstart++;
        }
        if (bflush) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
      }
      s.insert = 0;
      if (flush === Z_FINISH) {
        flush_block_only(s, true);
        if (s.strm.avail_out === 0) {
          return BS_FINISH_STARTED;
        }
        return BS_FINISH_DONE;
      }
      if (s.sym_next) {
        flush_block_only(s, false);
        if (s.strm.avail_out === 0) {
          return BS_NEED_MORE;
        }
      }
      return BS_BLOCK_DONE;
    };
    var deflate_huff = (s, flush) => {
      let bflush;
      for (; ; ) {
        if (s.lookahead === 0) {
          fill_window(s);
          if (s.lookahead === 0) {
            if (flush === Z_NO_FLUSH) {
              return BS_NEED_MORE;
            }
            break;
          }
        }
        s.match_length = 0;
        bflush = _tr_tally(s, 0, s.window[s.strstart]);
        s.lookahead--;
        s.strstart++;
        if (bflush) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) {
            return BS_NEED_MORE;
          }
        }
      }
      s.insert = 0;
      if (flush === Z_FINISH) {
        flush_block_only(s, true);
        if (s.strm.avail_out === 0) {
          return BS_FINISH_STARTED;
        }
        return BS_FINISH_DONE;
      }
      if (s.sym_next) {
        flush_block_only(s, false);
        if (s.strm.avail_out === 0) {
          return BS_NEED_MORE;
        }
      }
      return BS_BLOCK_DONE;
    };
    function Config(good_length, max_lazy, nice_length, max_chain, func) {
      this.good_length = good_length;
      this.max_lazy = max_lazy;
      this.nice_length = nice_length;
      this.max_chain = max_chain;
      this.func = func;
    }
    var configuration_table = [
      /*      good lazy nice chain */
      new Config(0, 0, 0, 0, deflate_stored),
      /* 0 store only */
      new Config(4, 4, 8, 4, deflate_fast),
      /* 1 max speed, no lazy matches */
      new Config(4, 5, 16, 8, deflate_fast),
      /* 2 */
      new Config(4, 6, 32, 32, deflate_fast),
      /* 3 */
      new Config(4, 4, 16, 16, deflate_slow),
      /* 4 lazy matches */
      new Config(8, 16, 32, 32, deflate_slow),
      /* 5 */
      new Config(8, 16, 128, 128, deflate_slow),
      /* 6 */
      new Config(8, 32, 128, 256, deflate_slow),
      /* 7 */
      new Config(32, 128, 258, 1024, deflate_slow),
      /* 8 */
      new Config(32, 258, 258, 4096, deflate_slow)
      /* 9 max compression */
    ];
    var lm_init = (s) => {
      s.window_size = 2 * s.w_size;
      zero(s.head);
      s.max_lazy_match = configuration_table[s.level].max_lazy;
      s.good_match = configuration_table[s.level].good_length;
      s.nice_match = configuration_table[s.level].nice_length;
      s.max_chain_length = configuration_table[s.level].max_chain;
      s.strstart = 0;
      s.block_start = 0;
      s.lookahead = 0;
      s.insert = 0;
      s.match_length = s.prev_length = MIN_MATCH - 1;
      s.match_available = 0;
      s.ins_h = 0;
    };
    function DeflateState() {
      this.strm = null;
      this.status = 0;
      this.pending_buf = null;
      this.pending_buf_size = 0;
      this.pending_out = 0;
      this.pending = 0;
      this.wrap = 0;
      this.gzhead = null;
      this.gzindex = 0;
      this.method = Z_DEFLATED;
      this.last_flush = -1;
      this.w_size = 0;
      this.w_bits = 0;
      this.w_mask = 0;
      this.window = null;
      this.window_size = 0;
      this.prev = null;
      this.head = null;
      this.ins_h = 0;
      this.legacy_hash = 0;
      this.hash_size = 0;
      this.hash_bits = 0;
      this.hash_mask = 0;
      this.hash_shift = 0;
      this.block_start = 0;
      this.match_length = 0;
      this.prev_match = 0;
      this.match_available = 0;
      this.strstart = 0;
      this.match_start = 0;
      this.lookahead = 0;
      this.prev_length = 0;
      this.max_chain_length = 0;
      this.max_lazy_match = 0;
      this.level = 0;
      this.strategy = 0;
      this.good_match = 0;
      this.nice_match = 0;
      this.dyn_ltree = new Uint16Array(HEAP_SIZE * 2);
      this.dyn_dtree = new Uint16Array((2 * D_CODES + 1) * 2);
      this.bl_tree = new Uint16Array((2 * BL_CODES + 1) * 2);
      zero(this.dyn_ltree);
      zero(this.dyn_dtree);
      zero(this.bl_tree);
      this.l_desc = null;
      this.d_desc = null;
      this.bl_desc = null;
      this.bl_count = new Uint16Array(MAX_BITS + 1);
      this.heap = new Uint16Array(2 * L_CODES + 1);
      zero(this.heap);
      this.heap_len = 0;
      this.heap_max = 0;
      this.depth = new Uint16Array(2 * L_CODES + 1);
      zero(this.depth);
      this.sym_buf = 0;
      this.lit_bufsize = 0;
      this.sym_next = 0;
      this.sym_end = 0;
      this.opt_len = 0;
      this.static_len = 0;
      this.matches = 0;
      this.insert = 0;
      this.bi_buf = 0;
      this.bi_valid = 0;
    }
    var deflateStateCheck = (strm) => {
      if (!strm) {
        return 1;
      }
      const s = strm.state;
      if (!s || s.strm !== strm || s.status !== INIT_STATE && //#ifdef GZIP
      s.status !== GZIP_STATE && //#endif
      s.status !== EXTRA_STATE && s.status !== NAME_STATE && s.status !== COMMENT_STATE && s.status !== HCRC_STATE && s.status !== BUSY_STATE && s.status !== FINISH_STATE) {
        return 1;
      }
      return 0;
    };
    var deflateResetKeep = (strm) => {
      if (deflateStateCheck(strm)) {
        return err(strm, Z_STREAM_ERROR);
      }
      strm.total_in = strm.total_out = 0;
      strm.data_type = Z_UNKNOWN;
      const s = strm.state;
      s.pending = 0;
      s.pending_out = 0;
      if (s.wrap < 0) {
        s.wrap = -s.wrap;
      }
      s.status = //#ifdef GZIP
      s.wrap === 2 ? GZIP_STATE : (
        //#endif
        s.wrap ? INIT_STATE : BUSY_STATE
      );
      strm.adler = s.wrap === 2 ? 0 : 1;
      s.last_flush = -2;
      _tr_init(s);
      return Z_OK;
    };
    var deflateReset = (strm) => {
      const ret = deflateResetKeep(strm);
      if (ret === Z_OK) {
        lm_init(strm.state);
      }
      return ret;
    };
    var deflateSetHeader = (strm, head) => {
      if (deflateStateCheck(strm) || strm.state.wrap !== 2) {
        return Z_STREAM_ERROR;
      }
      strm.state.gzhead = head;
      return Z_OK;
    };
    var deflateInit2 = (strm, level, method, windowBits, memLevel, strategy, legacyHash) => {
      if (!strm) {
        return Z_STREAM_ERROR;
      }
      let wrap = 1;
      if (level === Z_DEFAULT_COMPRESSION) {
        level = 6;
      }
      if (windowBits < 0) {
        wrap = 0;
        windowBits = -windowBits;
      } else if (windowBits > 15) {
        wrap = 2;
        windowBits -= 16;
      }
      if (memLevel < 1 || memLevel > MAX_MEM_LEVEL || method !== Z_DEFLATED || windowBits < 8 || windowBits > 15 || level < 0 || level > 9 || strategy < 0 || strategy > Z_FIXED || windowBits === 8 && wrap !== 1) {
        return err(strm, Z_STREAM_ERROR);
      }
      if (windowBits === 8) {
        windowBits = 9;
      }
      const s = new DeflateState();
      strm.state = s;
      s.strm = strm;
      s.status = INIT_STATE;
      s.wrap = wrap;
      s.gzhead = null;
      s.w_bits = windowBits;
      s.w_size = 1 << s.w_bits;
      s.w_mask = s.w_size - 1;
      s.legacy_hash = legacyHash ? 1 : 0;
      s.hash_bits = memLevel + 7;
      if (!s.legacy_hash && s.hash_bits < 15) {
        s.hash_bits = 15;
      }
      s.hash_size = 1 << s.hash_bits;
      s.hash_mask = s.hash_size - 1;
      s.hash_shift = ~~((s.hash_bits + MIN_MATCH - 1) / MIN_MATCH);
      s.window = new Uint8Array(s.w_size * 2);
      s.head = new Uint16Array(s.hash_size);
      s.prev = new Uint16Array(s.w_size);
      s.lit_bufsize = 1 << memLevel + 6;
      s.pending_buf_size = s.lit_bufsize * 4;
      s.pending_buf = new Uint8Array(s.pending_buf_size);
      s.sym_buf = s.lit_bufsize;
      s.sym_end = (s.lit_bufsize - 1) * 3;
      s.level = level;
      s.strategy = strategy;
      s.method = method;
      return deflateReset(strm);
    };
    var deflateInit = (strm, level) => {
      return deflateInit2(strm, level, Z_DEFLATED, MAX_WBITS, DEF_MEM_LEVEL, Z_DEFAULT_STRATEGY);
    };
    var deflate = (strm, flush) => {
      if (deflateStateCheck(strm) || flush > Z_BLOCK || flush < 0) {
        return strm ? err(strm, Z_STREAM_ERROR) : Z_STREAM_ERROR;
      }
      const s = strm.state;
      if (!strm.output || strm.avail_in !== 0 && !strm.input || s.status === FINISH_STATE && flush !== Z_FINISH) {
        return err(strm, strm.avail_out === 0 ? Z_BUF_ERROR : Z_STREAM_ERROR);
      }
      const old_flush = s.last_flush;
      s.last_flush = flush;
      if (s.pending !== 0) {
        flush_pending(strm);
        if (strm.avail_out === 0) {
          s.last_flush = -1;
          return Z_OK;
        }
      } else if (strm.avail_in === 0 && rank(flush) <= rank(old_flush) && flush !== Z_FINISH) {
        return err(strm, Z_BUF_ERROR);
      }
      if (s.status === FINISH_STATE && strm.avail_in !== 0) {
        return err(strm, Z_BUF_ERROR);
      }
      if (s.status === INIT_STATE && s.wrap === 0) {
        s.status = BUSY_STATE;
      }
      if (s.status === INIT_STATE) {
        let header = Z_DEFLATED + (s.w_bits - 8 << 4) << 8;
        let level_flags = -1;
        if (s.strategy >= Z_HUFFMAN_ONLY || s.level < 2) {
          level_flags = 0;
        } else if (s.level < 6) {
          level_flags = 1;
        } else if (s.level === 6) {
          level_flags = 2;
        } else {
          level_flags = 3;
        }
        header |= level_flags << 6;
        if (s.strstart !== 0) {
          header |= PRESET_DICT;
        }
        header += 31 - header % 31;
        putShortMSB(s, header);
        if (s.strstart !== 0) {
          putShortMSB(s, strm.adler >>> 16);
          putShortMSB(s, strm.adler & 65535);
        }
        strm.adler = 1;
        s.status = BUSY_STATE;
        flush_pending(strm);
        if (s.pending !== 0) {
          s.last_flush = -1;
          return Z_OK;
        }
      }
      if (s.status === GZIP_STATE) {
        strm.adler = 0;
        put_byte(s, 31);
        put_byte(s, 139);
        put_byte(s, 8);
        if (!s.gzhead) {
          put_byte(s, 0);
          put_byte(s, 0);
          put_byte(s, 0);
          put_byte(s, 0);
          put_byte(s, 0);
          put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
          put_byte(s, OS_CODE);
          s.status = BUSY_STATE;
          flush_pending(strm);
          if (s.pending !== 0) {
            s.last_flush = -1;
            return Z_OK;
          }
        } else {
          put_byte(
            s,
            (s.gzhead.text ? 1 : 0) + (s.gzhead.hcrc ? 2 : 0) + (!s.gzhead.extra ? 0 : 4) + (!s.gzhead.name ? 0 : 8) + (!s.gzhead.comment ? 0 : 16)
          );
          put_byte(s, s.gzhead.time & 255);
          put_byte(s, s.gzhead.time >> 8 & 255);
          put_byte(s, s.gzhead.time >> 16 & 255);
          put_byte(s, s.gzhead.time >> 24 & 255);
          put_byte(s, s.level === 9 ? 2 : s.strategy >= Z_HUFFMAN_ONLY || s.level < 2 ? 4 : 0);
          put_byte(s, s.gzhead.os & 255);
          if (s.gzhead.extra && s.gzhead.extra.length) {
            put_byte(s, s.gzhead.extra.length & 255);
            put_byte(s, s.gzhead.extra.length >> 8 & 255);
          }
          if (s.gzhead.hcrc) {
            strm.adler = crc32(strm.adler, s.pending_buf, s.pending, 0);
          }
          s.gzindex = 0;
          s.status = EXTRA_STATE;
        }
      }
      if (s.status === EXTRA_STATE) {
        if (s.gzhead.extra) {
          let beg = s.pending;
          let left = (s.gzhead.extra.length & 65535) - s.gzindex;
          while (s.pending + left > s.pending_buf_size) {
            let copy = s.pending_buf_size - s.pending;
            s.pending_buf.set(s.gzhead.extra.subarray(s.gzindex, s.gzindex + copy), s.pending);
            s.pending = s.pending_buf_size;
            if (s.gzhead.hcrc && s.pending > beg) {
              strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            }
            s.gzindex += copy;
            flush_pending(strm);
            if (s.pending !== 0) {
              s.last_flush = -1;
              return Z_OK;
            }
            beg = 0;
            left -= copy;
          }
          let gzhead_extra = new Uint8Array(s.gzhead.extra);
          s.pending_buf.set(gzhead_extra.subarray(s.gzindex, s.gzindex + left), s.pending);
          s.pending += left;
          if (s.gzhead.hcrc && s.pending > beg) {
            strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
          }
          s.gzindex = 0;
        }
        s.status = NAME_STATE;
      }
      if (s.status === NAME_STATE) {
        if (s.gzhead.name) {
          let beg = s.pending;
          let val;
          do {
            if (s.pending === s.pending_buf_size) {
              if (s.gzhead.hcrc && s.pending > beg) {
                strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
              }
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return Z_OK;
              }
              beg = 0;
            }
            if (s.gzindex < s.gzhead.name.length) {
              val = s.gzhead.name.charCodeAt(s.gzindex++) & 255;
            } else {
              val = 0;
            }
            put_byte(s, val);
          } while (val !== 0);
          if (s.gzhead.hcrc && s.pending > beg) {
            strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
          }
          s.gzindex = 0;
        }
        s.status = COMMENT_STATE;
      }
      if (s.status === COMMENT_STATE) {
        if (s.gzhead.comment) {
          let beg = s.pending;
          let val;
          do {
            if (s.pending === s.pending_buf_size) {
              if (s.gzhead.hcrc && s.pending > beg) {
                strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
              }
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return Z_OK;
              }
              beg = 0;
            }
            if (s.gzindex < s.gzhead.comment.length) {
              val = s.gzhead.comment.charCodeAt(s.gzindex++) & 255;
            } else {
              val = 0;
            }
            put_byte(s, val);
          } while (val !== 0);
          if (s.gzhead.hcrc && s.pending > beg) {
            strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
          }
        }
        s.status = HCRC_STATE;
      }
      if (s.status === HCRC_STATE) {
        if (s.gzhead.hcrc) {
          if (s.pending + 2 > s.pending_buf_size) {
            flush_pending(strm);
            if (s.pending !== 0) {
              s.last_flush = -1;
              return Z_OK;
            }
          }
          put_byte(s, strm.adler & 255);
          put_byte(s, strm.adler >> 8 & 255);
          strm.adler = 0;
        }
        s.status = BUSY_STATE;
        flush_pending(strm);
        if (s.pending !== 0) {
          s.last_flush = -1;
          return Z_OK;
        }
      }
      if (strm.avail_in !== 0 || s.lookahead !== 0 || flush !== Z_NO_FLUSH && s.status !== FINISH_STATE) {
        let bstate = s.level === 0 ? deflate_stored(s, flush) : s.strategy === Z_HUFFMAN_ONLY ? deflate_huff(s, flush) : s.strategy === Z_RLE ? deflate_rle(s, flush) : configuration_table[s.level].func(s, flush);
        if (bstate === BS_FINISH_STARTED || bstate === BS_FINISH_DONE) {
          s.status = FINISH_STATE;
        }
        if (bstate === BS_NEED_MORE || bstate === BS_FINISH_STARTED) {
          if (strm.avail_out === 0) {
            s.last_flush = -1;
          }
          return Z_OK;
        }
        if (bstate === BS_BLOCK_DONE) {
          if (flush === Z_PARTIAL_FLUSH) {
            _tr_align(s);
          } else if (flush !== Z_BLOCK) {
            _tr_stored_block(s, 0, 0, false);
            if (flush === Z_FULL_FLUSH) {
              zero(s.head);
              if (s.lookahead === 0) {
                s.strstart = 0;
                s.block_start = 0;
                s.insert = 0;
              }
            }
          }
          flush_pending(strm);
          if (strm.avail_out === 0) {
            s.last_flush = -1;
            return Z_OK;
          }
        }
      }
      if (flush !== Z_FINISH) {
        return Z_OK;
      }
      if (s.wrap <= 0) {
        return Z_STREAM_END;
      }
      if (s.wrap === 2) {
        put_byte(s, strm.adler & 255);
        put_byte(s, strm.adler >> 8 & 255);
        put_byte(s, strm.adler >> 16 & 255);
        put_byte(s, strm.adler >> 24 & 255);
        put_byte(s, strm.total_in & 255);
        put_byte(s, strm.total_in >> 8 & 255);
        put_byte(s, strm.total_in >> 16 & 255);
        put_byte(s, strm.total_in >> 24 & 255);
      } else {
        putShortMSB(s, strm.adler >>> 16);
        putShortMSB(s, strm.adler & 65535);
      }
      flush_pending(strm);
      if (s.wrap > 0) {
        s.wrap = -s.wrap;
      }
      return s.pending !== 0 ? Z_OK : Z_STREAM_END;
    };
    var deflateEnd = (strm) => {
      if (deflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const status = strm.state.status;
      strm.state = null;
      return status === BUSY_STATE ? err(strm, Z_DATA_ERROR) : Z_OK;
    };
    var deflateSetDictionary = (strm, dictionary) => {
      let dictLength = dictionary.length;
      if (deflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const s = strm.state;
      const wrap = s.wrap;
      if (wrap === 2 || wrap === 1 && s.status !== INIT_STATE || s.lookahead) {
        return Z_STREAM_ERROR;
      }
      if (wrap === 1) {
        strm.adler = adler32(strm.adler, dictionary, dictLength, 0);
      }
      s.wrap = 0;
      if (dictLength >= s.w_size) {
        if (wrap === 0) {
          zero(s.head);
          s.strstart = 0;
          s.block_start = 0;
          s.insert = 0;
        }
        let tmpDict = new Uint8Array(s.w_size);
        tmpDict.set(dictionary.subarray(dictLength - s.w_size, dictLength), 0);
        dictionary = tmpDict;
        dictLength = s.w_size;
      }
      const avail = strm.avail_in;
      const next = strm.next_in;
      const input = strm.input;
      strm.avail_in = dictLength;
      strm.next_in = 0;
      strm.input = dictionary;
      fill_window(s);
      while (s.lookahead >= MIN_MATCH) {
        let str = s.strstart;
        let n = s.lookahead - (MIN_MATCH - 1);
        do {
          INSERT_STRING(s, str);
          str++;
        } while (--n);
        s.strstart = str;
        s.lookahead = MIN_MATCH - 1;
        fill_window(s);
      }
      s.strstart += s.lookahead;
      s.block_start = s.strstart;
      s.insert = s.lookahead;
      s.lookahead = 0;
      s.match_length = s.prev_length = MIN_MATCH - 1;
      s.match_available = 0;
      strm.next_in = next;
      strm.input = input;
      strm.avail_in = avail;
      s.wrap = wrap;
      return Z_OK;
    };
    module.exports.deflateInit = deflateInit;
    module.exports.deflateInit2 = deflateInit2;
    module.exports.deflateReset = deflateReset;
    module.exports.deflateResetKeep = deflateResetKeep;
    module.exports.deflateSetHeader = deflateSetHeader;
    module.exports.deflate = deflate;
    module.exports.deflateEnd = deflateEnd;
    module.exports.deflateSetDictionary = deflateSetDictionary;
    module.exports.deflateInfo = "pako deflate (from Nodeca project)";
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/utils/common.js
var require_common2 = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/utils/common.js"(exports, module) {
    "use strict";
    var _has = (obj, key2) => {
      return Object.prototype.hasOwnProperty.call(obj, key2);
    };
    module.exports.assign = function(obj) {
      const sources = Array.prototype.slice.call(arguments, 1);
      while (sources.length) {
        const source = sources.shift();
        if (!source) {
          continue;
        }
        if (typeof source !== "object") {
          throw new TypeError(source + "must be non-object");
        }
        for (const p in source) {
          if (_has(source, p)) {
            obj[p] = source[p];
          }
        }
      }
      return obj;
    };
    module.exports.flattenChunks = (chunks) => {
      let len = 0;
      for (let i = 0, l = chunks.length; i < l; i++) {
        len += chunks[i].length;
      }
      const result = new Uint8Array(len);
      for (let i = 0, pos = 0, l = chunks.length; i < l; i++) {
        let chunk = chunks[i];
        result.set(chunk, pos);
        pos += chunk.length;
      }
      return result;
    };
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/utils/strings.js
var require_strings = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/utils/strings.js"(exports, module) {
    "use strict";
    var STR_APPLY_UIA_OK = true;
    try {
      String.fromCharCode.apply(null, new Uint8Array(1));
    } catch (__) {
      STR_APPLY_UIA_OK = false;
    }
    var _utf8len = new Uint8Array(256);
    for (let q = 0; q < 256; q++) {
      _utf8len[q] = q >= 252 ? 6 : q >= 248 ? 5 : q >= 240 ? 4 : q >= 224 ? 3 : q >= 192 ? 2 : 1;
    }
    _utf8len[254] = _utf8len[255] = 1;
    module.exports.string2buf = (str) => {
      if (typeof TextEncoder === "function" && TextEncoder.prototype.encode) {
        return new TextEncoder().encode(str);
      }
      let buf, c, c2, m_pos, i, str_len = str.length, buf_len = 0;
      for (m_pos = 0; m_pos < str_len; m_pos++) {
        c = str.charCodeAt(m_pos);
        if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
          c2 = str.charCodeAt(m_pos + 1);
          if ((c2 & 64512) === 56320) {
            c = 65536 + (c - 55296 << 10) + (c2 - 56320);
            m_pos++;
          }
        }
        buf_len += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
      }
      buf = new Uint8Array(buf_len);
      for (i = 0, m_pos = 0; i < buf_len; m_pos++) {
        c = str.charCodeAt(m_pos);
        if ((c & 64512) === 55296 && m_pos + 1 < str_len) {
          c2 = str.charCodeAt(m_pos + 1);
          if ((c2 & 64512) === 56320) {
            c = 65536 + (c - 55296 << 10) + (c2 - 56320);
            m_pos++;
          }
        }
        if (c < 128) {
          buf[i++] = c;
        } else if (c < 2048) {
          buf[i++] = 192 | c >>> 6;
          buf[i++] = 128 | c & 63;
        } else if (c < 65536) {
          buf[i++] = 224 | c >>> 12;
          buf[i++] = 128 | c >>> 6 & 63;
          buf[i++] = 128 | c & 63;
        } else {
          buf[i++] = 240 | c >>> 18;
          buf[i++] = 128 | c >>> 12 & 63;
          buf[i++] = 128 | c >>> 6 & 63;
          buf[i++] = 128 | c & 63;
        }
      }
      return buf;
    };
    var buf2binstring = (buf, len) => {
      if (len < 65534) {
        if (buf.subarray && STR_APPLY_UIA_OK) {
          return String.fromCharCode.apply(null, buf.length === len ? buf : buf.subarray(0, len));
        }
      }
      let result = "";
      for (let i = 0; i < len; i++) {
        result += String.fromCharCode(buf[i]);
      }
      return result;
    };
    module.exports.buf2string = (buf, max) => {
      const len = max || buf.length;
      if (typeof TextDecoder === "function" && TextDecoder.prototype.decode) {
        return new TextDecoder().decode(buf.subarray(0, max));
      }
      let i, out;
      const utf16buf = new Array(len * 2);
      for (out = 0, i = 0; i < len; ) {
        let c = buf[i++];
        if (c < 128) {
          utf16buf[out++] = c;
          continue;
        }
        let c_len = _utf8len[c];
        if (c_len > 4) {
          utf16buf[out++] = 65533;
          i += c_len - 1;
          continue;
        }
        c &= c_len === 2 ? 31 : c_len === 3 ? 15 : 7;
        while (c_len > 1 && i < len) {
          c = c << 6 | buf[i++] & 63;
          c_len--;
        }
        if (c_len > 1) {
          utf16buf[out++] = 65533;
          continue;
        }
        if (c < 65536) {
          utf16buf[out++] = c;
        } else {
          c -= 65536;
          utf16buf[out++] = 55296 | c >> 10 & 1023;
          utf16buf[out++] = 56320 | c & 1023;
        }
      }
      return buf2binstring(utf16buf, out);
    };
    module.exports.utf8border = (buf, max) => {
      max = max || buf.length;
      if (max > buf.length) {
        max = buf.length;
      }
      let pos = max - 1;
      while (pos >= 0 && (buf[pos] & 192) === 128) {
        pos--;
      }
      if (pos < 0) {
        return max;
      }
      if (pos === 0) {
        return max;
      }
      return pos + _utf8len[buf[pos]] > max ? pos : max;
    };
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/zstream.js
var require_zstream = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/zstream.js"(exports, module) {
    "use strict";
    function ZStream() {
      this.input = null;
      this.next_in = 0;
      this.avail_in = 0;
      this.total_in = 0;
      this.output = null;
      this.next_out = 0;
      this.avail_out = 0;
      this.total_out = 0;
      this.msg = "";
      this.state = null;
      this.data_type = 2;
      this.adler = 0;
    }
    module.exports = ZStream;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/deflate.js
var require_deflate2 = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/deflate.js"(exports, module) {
    "use strict";
    var zlib_deflate = require_deflate();
    var utils = require_common2();
    var strings = require_strings();
    var msg = require_messages();
    var ZStream = require_zstream();
    var toString = Object.prototype.toString;
    var {
      Z_NO_FLUSH,
      Z_SYNC_FLUSH,
      Z_FULL_FLUSH,
      Z_FINISH,
      Z_OK,
      Z_STREAM_END,
      Z_DEFAULT_COMPRESSION,
      Z_DEFAULT_STRATEGY,
      Z_DEFLATED
    } = require_constants();
    var defaultOptions = {
      level: Z_DEFAULT_COMPRESSION,
      method: Z_DEFLATED,
      chunkSize: 16384,
      windowBits: 15,
      memLevel: 8,
      strategy: Z_DEFAULT_STRATEGY,
      legacyHash: true
    };
    function Deflate(options) {
      this.options = utils.assign({}, defaultOptions, options || {});
      let opt = this.options;
      if (opt.raw && opt.windowBits > 0) {
        opt.windowBits = -opt.windowBits;
      } else if (opt.gzip && opt.windowBits > 0 && opt.windowBits < 16) {
        opt.windowBits += 16;
      }
      this.err = 0;
      this.msg = "";
      this.ended = false;
      this.chunks = [];
      this.strm = new ZStream();
      this.strm.avail_out = 0;
      let status = zlib_deflate.deflateInit2(
        this.strm,
        opt.level,
        opt.method,
        opt.windowBits,
        opt.memLevel,
        opt.strategy,
        opt.legacyHash
      );
      if (status !== Z_OK) {
        throw new Error(msg[status]);
      }
      if (opt.header) {
        zlib_deflate.deflateSetHeader(this.strm, opt.header);
      }
      if (opt.dictionary) {
        let dict;
        if (typeof opt.dictionary === "string") {
          dict = strings.string2buf(opt.dictionary);
        } else if (toString.call(opt.dictionary) === "[object ArrayBuffer]") {
          dict = new Uint8Array(opt.dictionary);
        } else {
          dict = opt.dictionary;
        }
        status = zlib_deflate.deflateSetDictionary(this.strm, dict);
        if (status !== Z_OK) {
          throw new Error(msg[status]);
        }
        this._dict_set = true;
      }
    }
    Deflate.prototype.push = function(data, flush_mode) {
      const strm = this.strm;
      const chunkSize = this.options.chunkSize;
      let status, _flush_mode;
      if (this.ended) {
        return false;
      }
      if (flush_mode === ~~flush_mode) _flush_mode = flush_mode;
      else _flush_mode = flush_mode === true ? Z_FINISH : Z_NO_FLUSH;
      if (typeof data === "string") {
        strm.input = strings.string2buf(data);
      } else if (toString.call(data) === "[object ArrayBuffer]") {
        strm.input = new Uint8Array(data);
      } else {
        strm.input = data;
      }
      strm.next_in = 0;
      strm.avail_in = strm.input.length;
      for (; ; ) {
        if (strm.avail_out === 0) {
          strm.output = new Uint8Array(chunkSize);
          strm.next_out = 0;
          strm.avail_out = chunkSize;
        }
        if ((_flush_mode === Z_SYNC_FLUSH || _flush_mode === Z_FULL_FLUSH) && strm.avail_out <= 6) {
          this.onData(strm.output.subarray(0, strm.next_out));
          strm.avail_out = 0;
          continue;
        }
        status = zlib_deflate.deflate(strm, _flush_mode);
        if (status === Z_STREAM_END) {
          if (strm.next_out > 0) {
            this.onData(strm.output.subarray(0, strm.next_out));
          }
          status = zlib_deflate.deflateEnd(this.strm);
          this.onEnd(status);
          this.ended = true;
          return status === Z_OK;
        }
        if (strm.avail_out === 0) {
          this.onData(strm.output);
          continue;
        }
        if (_flush_mode > 0 && strm.next_out > 0) {
          this.onData(strm.output.subarray(0, strm.next_out));
          strm.avail_out = 0;
          continue;
        }
        if (strm.avail_in === 0) break;
      }
      return true;
    };
    Deflate.prototype.onData = function(chunk) {
      this.chunks.push(chunk);
    };
    Deflate.prototype.onEnd = function(status) {
      if (status === Z_OK) {
        this.result = utils.flattenChunks(this.chunks);
      }
      this.chunks = [];
      this.err = status;
      this.msg = this.strm.msg;
    };
    function deflate(input, options) {
      const deflator = new Deflate(options);
      deflator.push(input, true);
      if (deflator.err) {
        throw deflator.msg || msg[deflator.err];
      }
      return deflator.result;
    }
    function deflateRaw(input, options) {
      options = options || {};
      options.raw = true;
      return deflate(input, options);
    }
    function gzip(input, options) {
      options = options || {};
      options.gzip = true;
      return deflate(input, options);
    }
    module.exports.Deflate = Deflate;
    module.exports.deflate = deflate;
    module.exports.deflateRaw = deflateRaw;
    module.exports.gzip = gzip;
    module.exports.constants = require_constants();
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inffast.js
var require_inffast = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inffast.js"(exports, module) {
    "use strict";
    var BAD = 16209;
    var TYPE = 16191;
    module.exports = function inflate_fast(strm, start) {
      let _in;
      let last;
      let _out;
      let beg;
      let end;
      let dmax;
      let wsize;
      let whave;
      let wnext;
      let s_window;
      let hold;
      let bits;
      let lcode;
      let dcode;
      let lmask;
      let dmask;
      let here;
      let op;
      let len;
      let dist;
      let from;
      let from_source;
      let input, output;
      const state = strm.state;
      _in = strm.next_in;
      input = strm.input;
      last = _in + (strm.avail_in - 5);
      _out = strm.next_out;
      output = strm.output;
      beg = _out - (start - strm.avail_out);
      end = _out + (strm.avail_out - 257);
      dmax = state.dmax;
      wsize = state.wsize;
      whave = state.whave;
      wnext = state.wnext;
      s_window = state.window;
      hold = state.hold;
      bits = state.bits;
      lcode = state.lencode;
      dcode = state.distcode;
      lmask = (1 << state.lenbits) - 1;
      dmask = (1 << state.distbits) - 1;
      top:
        do {
          if (bits < 15) {
            hold += input[_in++] << bits;
            bits += 8;
            hold += input[_in++] << bits;
            bits += 8;
          }
          here = lcode[hold & lmask];
          dolen:
            for (; ; ) {
              op = here >>> 24;
              hold >>>= op;
              bits -= op;
              op = here >>> 16 & 255;
              if (op === 0) {
                output[_out++] = here & 65535;
              } else if (op & 16) {
                len = here & 65535;
                op &= 15;
                if (op) {
                  if (bits < op) {
                    hold += input[_in++] << bits;
                    bits += 8;
                  }
                  len += hold & (1 << op) - 1;
                  hold >>>= op;
                  bits -= op;
                }
                if (bits < 15) {
                  hold += input[_in++] << bits;
                  bits += 8;
                  hold += input[_in++] << bits;
                  bits += 8;
                }
                here = dcode[hold & dmask];
                dodist:
                  for (; ; ) {
                    op = here >>> 24;
                    hold >>>= op;
                    bits -= op;
                    op = here >>> 16 & 255;
                    if (op & 16) {
                      dist = here & 65535;
                      op &= 15;
                      if (bits < op) {
                        hold += input[_in++] << bits;
                        bits += 8;
                        if (bits < op) {
                          hold += input[_in++] << bits;
                          bits += 8;
                        }
                      }
                      dist += hold & (1 << op) - 1;
                      if (dist > dmax) {
                        strm.msg = "invalid distance too far back";
                        state.mode = BAD;
                        break top;
                      }
                      hold >>>= op;
                      bits -= op;
                      op = _out - beg;
                      if (dist > op) {
                        op = dist - op;
                        if (op > whave) {
                          if (state.sane) {
                            strm.msg = "invalid distance too far back";
                            state.mode = BAD;
                            break top;
                          }
                        }
                        from = 0;
                        from_source = s_window;
                        if (wnext === 0) {
                          from += wsize - op;
                          if (op < len) {
                            len -= op;
                            do {
                              output[_out++] = s_window[from++];
                            } while (--op);
                            from = _out - dist;
                            from_source = output;
                          }
                        } else if (wnext < op) {
                          from += wsize + wnext - op;
                          op -= wnext;
                          if (op < len) {
                            len -= op;
                            do {
                              output[_out++] = s_window[from++];
                            } while (--op);
                            from = 0;
                            if (wnext < len) {
                              op = wnext;
                              len -= op;
                              do {
                                output[_out++] = s_window[from++];
                              } while (--op);
                              from = _out - dist;
                              from_source = output;
                            }
                          }
                        } else {
                          from += wnext - op;
                          if (op < len) {
                            len -= op;
                            do {
                              output[_out++] = s_window[from++];
                            } while (--op);
                            from = _out - dist;
                            from_source = output;
                          }
                        }
                        while (len > 2) {
                          output[_out++] = from_source[from++];
                          output[_out++] = from_source[from++];
                          output[_out++] = from_source[from++];
                          len -= 3;
                        }
                        if (len) {
                          output[_out++] = from_source[from++];
                          if (len > 1) {
                            output[_out++] = from_source[from++];
                          }
                        }
                      } else {
                        from = _out - dist;
                        do {
                          output[_out++] = output[from++];
                          output[_out++] = output[from++];
                          output[_out++] = output[from++];
                          len -= 3;
                        } while (len > 2);
                        if (len) {
                          output[_out++] = output[from++];
                          if (len > 1) {
                            output[_out++] = output[from++];
                          }
                        }
                      }
                    } else if ((op & 64) === 0) {
                      here = dcode[(here & 65535) + (hold & (1 << op) - 1)];
                      continue dodist;
                    } else {
                      strm.msg = "invalid distance code";
                      state.mode = BAD;
                      break top;
                    }
                    break;
                  }
              } else if ((op & 64) === 0) {
                here = lcode[(here & 65535) + (hold & (1 << op) - 1)];
                continue dolen;
              } else if (op & 32) {
                state.mode = TYPE;
                break top;
              } else {
                strm.msg = "invalid literal/length code";
                state.mode = BAD;
                break top;
              }
              break;
            }
        } while (_in < last && _out < end);
      len = bits >> 3;
      _in -= len;
      bits -= len << 3;
      hold &= (1 << bits) - 1;
      strm.next_in = _in;
      strm.next_out = _out;
      strm.avail_in = _in < last ? 5 + (last - _in) : 5 - (_in - last);
      strm.avail_out = _out < end ? 257 + (end - _out) : 257 - (_out - end);
      state.hold = hold;
      state.bits = bits;
      return;
    };
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inftrees.js
var require_inftrees = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inftrees.js"(exports, module) {
    "use strict";
    var MAXBITS = 15;
    var ENOUGH_LENS = 852;
    var ENOUGH_DISTS = 592;
    var CODES = 0;
    var LENS = 1;
    var DISTS = 2;
    var lbase = new Uint16Array([
      /* Length codes 257..285 base */
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      13,
      15,
      17,
      19,
      23,
      27,
      31,
      35,
      43,
      51,
      59,
      67,
      83,
      99,
      115,
      131,
      163,
      195,
      227,
      258,
      0,
      0
    ]);
    var lext = new Uint8Array([
      /* Length codes 257..285 extra */
      16,
      16,
      16,
      16,
      16,
      16,
      16,
      16,
      17,
      17,
      17,
      17,
      18,
      18,
      18,
      18,
      19,
      19,
      19,
      19,
      20,
      20,
      20,
      20,
      21,
      21,
      21,
      21,
      16,
      199,
      75
    ]);
    var dbase = new Uint16Array([
      /* Distance codes 0..29 base */
      1,
      2,
      3,
      4,
      5,
      7,
      9,
      13,
      17,
      25,
      33,
      49,
      65,
      97,
      129,
      193,
      257,
      385,
      513,
      769,
      1025,
      1537,
      2049,
      3073,
      4097,
      6145,
      8193,
      12289,
      16385,
      24577,
      0,
      0
    ]);
    var dext = new Uint8Array([
      /* Distance codes 0..29 extra */
      16,
      16,
      16,
      16,
      17,
      17,
      18,
      18,
      19,
      19,
      20,
      20,
      21,
      21,
      22,
      22,
      23,
      23,
      24,
      24,
      25,
      25,
      26,
      26,
      27,
      27,
      28,
      28,
      29,
      29,
      64,
      64
    ]);
    var inflate_table = (type, lens, lens_index, codes, table2, table_index, work, opts) => {
      const bits = opts.bits;
      let len = 0;
      let sym = 0;
      let min = 0, max = 0;
      let root = 0;
      let curr = 0;
      let drop = 0;
      let left = 0;
      let used = 0;
      let huff = 0;
      let incr;
      let fill;
      let low;
      let mask;
      let next;
      let base = null;
      let match;
      const count = new Uint16Array(MAXBITS + 1);
      const offs = new Uint16Array(MAXBITS + 1);
      let extra = null;
      let here_bits, here_op, here_val;
      for (len = 0; len <= MAXBITS; len++) {
        count[len] = 0;
      }
      for (sym = 0; sym < codes; sym++) {
        count[lens[lens_index + sym]]++;
      }
      root = bits;
      for (max = MAXBITS; max >= 1; max--) {
        if (count[max] !== 0) {
          break;
        }
      }
      if (root > max) {
        root = max;
      }
      if (max === 0) {
        table2[table_index++] = 1 << 24 | 64 << 16 | 0;
        table2[table_index++] = 1 << 24 | 64 << 16 | 0;
        opts.bits = 1;
        return 0;
      }
      for (min = 1; min < max; min++) {
        if (count[min] !== 0) {
          break;
        }
      }
      if (root < min) {
        root = min;
      }
      left = 1;
      for (len = 1; len <= MAXBITS; len++) {
        left <<= 1;
        left -= count[len];
        if (left < 0) {
          return -1;
        }
      }
      if (left > 0 && (type === CODES || max !== 1)) {
        return -1;
      }
      offs[1] = 0;
      for (len = 1; len < MAXBITS; len++) {
        offs[len + 1] = offs[len] + count[len];
      }
      for (sym = 0; sym < codes; sym++) {
        if (lens[lens_index + sym] !== 0) {
          work[offs[lens[lens_index + sym]]++] = sym;
        }
      }
      if (type === CODES) {
        base = extra = work;
        match = 20;
      } else if (type === LENS) {
        base = lbase;
        extra = lext;
        match = 257;
      } else {
        base = dbase;
        extra = dext;
        match = 0;
      }
      huff = 0;
      sym = 0;
      len = min;
      next = table_index;
      curr = root;
      drop = 0;
      low = -1;
      used = 1 << root;
      mask = used - 1;
      if (type === LENS && used > ENOUGH_LENS || type === DISTS && used > ENOUGH_DISTS) {
        return 1;
      }
      for (; ; ) {
        here_bits = len - drop;
        if (work[sym] + 1 < match) {
          here_op = 0;
          here_val = work[sym];
        } else if (work[sym] >= match) {
          here_op = extra[work[sym] - match];
          here_val = base[work[sym] - match];
        } else {
          here_op = 32 + 64;
          here_val = 0;
        }
        incr = 1 << len - drop;
        fill = 1 << curr;
        min = fill;
        do {
          fill -= incr;
          table2[next + (huff >> drop) + fill] = here_bits << 24 | here_op << 16 | here_val | 0;
        } while (fill !== 0);
        incr = 1 << len - 1;
        while (huff & incr) {
          incr >>= 1;
        }
        if (incr !== 0) {
          huff &= incr - 1;
          huff += incr;
        } else {
          huff = 0;
        }
        sym++;
        if (--count[len] === 0) {
          if (len === max) {
            break;
          }
          len = lens[lens_index + work[sym]];
        }
        if (len > root && (huff & mask) !== low) {
          if (drop === 0) {
            drop = root;
          }
          next += min;
          curr = len - drop;
          left = 1 << curr;
          while (curr + drop < max) {
            left -= count[curr + drop];
            if (left <= 0) {
              break;
            }
            curr++;
            left <<= 1;
          }
          used += 1 << curr;
          if (type === LENS && used > ENOUGH_LENS || type === DISTS && used > ENOUGH_DISTS) {
            return 1;
          }
          low = huff & mask;
          table2[low] = root << 24 | curr << 16 | next - table_index | 0;
        }
      }
      if (huff !== 0) {
        table2[next + huff] = len - drop << 24 | 64 << 16 | 0;
      }
      opts.bits = root;
      return 0;
    };
    module.exports = inflate_table;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inflate.js
var require_inflate = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/inflate.js"(exports, module) {
    "use strict";
    var adler32 = require_adler32();
    var crc32 = require_crc32();
    var inflate_fast = require_inffast();
    var inflate_table = require_inftrees();
    var CODES = 0;
    var LENS = 1;
    var DISTS = 2;
    var {
      Z_FINISH,
      Z_BLOCK,
      Z_TREES,
      Z_OK,
      Z_STREAM_END,
      Z_NEED_DICT,
      Z_STREAM_ERROR,
      Z_DATA_ERROR,
      Z_MEM_ERROR,
      Z_BUF_ERROR,
      Z_DEFLATED
    } = require_constants();
    var HEAD = 16180;
    var FLAGS = 16181;
    var TIME = 16182;
    var OS = 16183;
    var EXLEN = 16184;
    var EXTRA = 16185;
    var NAME = 16186;
    var COMMENT = 16187;
    var HCRC = 16188;
    var DICTID = 16189;
    var DICT = 16190;
    var TYPE = 16191;
    var TYPEDO = 16192;
    var STORED = 16193;
    var COPY_ = 16194;
    var COPY = 16195;
    var TABLE = 16196;
    var LENLENS = 16197;
    var CODELENS = 16198;
    var LEN_ = 16199;
    var LEN = 16200;
    var LENEXT = 16201;
    var DIST = 16202;
    var DISTEXT = 16203;
    var MATCH = 16204;
    var LIT = 16205;
    var CHECK = 16206;
    var LENGTH = 16207;
    var DONE = 16208;
    var BAD = 16209;
    var MEM = 16210;
    var SYNC = 16211;
    var ENOUGH_LENS = 852;
    var ENOUGH_DISTS = 592;
    var MAX_WBITS = 15;
    var DEF_WBITS = MAX_WBITS;
    var zswap32 = (q) => {
      return (q >>> 24 & 255) + (q >>> 8 & 65280) + ((q & 65280) << 8) + ((q & 255) << 24);
    };
    function InflateState() {
      this.strm = null;
      this.mode = 0;
      this.last = false;
      this.wrap = 0;
      this.havedict = false;
      this.flags = 0;
      this.dmax = 0;
      this.check = 0;
      this.total = 0;
      this.head = null;
      this.wbits = 0;
      this.wsize = 0;
      this.whave = 0;
      this.wnext = 0;
      this.window = null;
      this.hold = 0;
      this.bits = 0;
      this.length = 0;
      this.offset = 0;
      this.extra = 0;
      this.lencode = null;
      this.distcode = null;
      this.lenbits = 0;
      this.distbits = 0;
      this.ncode = 0;
      this.nlen = 0;
      this.ndist = 0;
      this.have = 0;
      this.next = null;
      this.lens = new Uint16Array(320);
      this.work = new Uint16Array(288);
      this.lendyn = null;
      this.distdyn = null;
      this.sane = 0;
      this.back = 0;
      this.was = 0;
    }
    var inflateStateCheck = (strm) => {
      if (!strm) {
        return 1;
      }
      const state = strm.state;
      if (!state || state.strm !== strm || state.mode < HEAD || state.mode > SYNC) {
        return 1;
      }
      return 0;
    };
    var inflateResetKeep = (strm) => {
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const state = strm.state;
      strm.total_in = strm.total_out = state.total = 0;
      strm.msg = "";
      if (state.wrap) {
        strm.adler = state.wrap & 1;
      }
      state.mode = HEAD;
      state.last = 0;
      state.havedict = 0;
      state.flags = -1;
      state.dmax = 32768;
      state.head = null;
      state.hold = 0;
      state.bits = 0;
      state.lencode = state.lendyn = new Int32Array(ENOUGH_LENS);
      state.distcode = state.distdyn = new Int32Array(ENOUGH_DISTS);
      state.sane = 1;
      state.back = -1;
      return Z_OK;
    };
    var inflateReset = (strm) => {
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const state = strm.state;
      state.wsize = 0;
      state.whave = 0;
      state.wnext = 0;
      return inflateResetKeep(strm);
    };
    var inflateReset2 = (strm, windowBits) => {
      let wrap;
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const state = strm.state;
      if (windowBits < 0) {
        wrap = 0;
        windowBits = -windowBits;
      } else {
        wrap = (windowBits >> 4) + 5;
        if (windowBits < 48) {
          windowBits &= 15;
        }
      }
      if (windowBits && (windowBits < 8 || windowBits > 15)) {
        return Z_STREAM_ERROR;
      }
      if (state.window !== null && state.wbits !== windowBits) {
        state.window = null;
      }
      state.wrap = wrap;
      state.wbits = windowBits;
      return inflateReset(strm);
    };
    var inflateInit2 = (strm, windowBits) => {
      if (!strm) {
        return Z_STREAM_ERROR;
      }
      const state = new InflateState();
      strm.state = state;
      state.strm = strm;
      state.window = null;
      state.mode = HEAD;
      const ret = inflateReset2(strm, windowBits);
      if (ret !== Z_OK) {
        strm.state = null;
      }
      return ret;
    };
    var inflateInit = (strm) => {
      return inflateInit2(strm, DEF_WBITS);
    };
    var virgin = true;
    var lenfix;
    var distfix;
    var fixedtables = (state) => {
      if (virgin) {
        lenfix = new Int32Array(512);
        distfix = new Int32Array(32);
        let sym = 0;
        while (sym < 144) {
          state.lens[sym++] = 8;
        }
        while (sym < 256) {
          state.lens[sym++] = 9;
        }
        while (sym < 280) {
          state.lens[sym++] = 7;
        }
        while (sym < 288) {
          state.lens[sym++] = 8;
        }
        inflate_table(LENS, state.lens, 0, 288, lenfix, 0, state.work, { bits: 9 });
        sym = 0;
        while (sym < 32) {
          state.lens[sym++] = 5;
        }
        inflate_table(DISTS, state.lens, 0, 32, distfix, 0, state.work, { bits: 5 });
        virgin = false;
      }
      state.lencode = lenfix;
      state.lenbits = 9;
      state.distcode = distfix;
      state.distbits = 5;
    };
    var updatewindow = (strm, src, end, copy) => {
      let dist;
      const state = strm.state;
      if (state.window === null) {
        state.window = new Uint8Array(1 << state.wbits);
      }
      if (state.wsize === 0) {
        state.wsize = 1 << state.wbits;
        state.wnext = 0;
        state.whave = 0;
      }
      if (copy >= state.wsize) {
        state.window.set(src.subarray(end - state.wsize, end), 0);
        state.wnext = 0;
        state.whave = state.wsize;
      } else {
        dist = state.wsize - state.wnext;
        if (dist > copy) {
          dist = copy;
        }
        state.window.set(src.subarray(end - copy, end - copy + dist), state.wnext);
        copy -= dist;
        if (copy) {
          state.window.set(src.subarray(end - copy, end), 0);
          state.wnext = copy;
          state.whave = state.wsize;
        } else {
          state.wnext += dist;
          if (state.wnext === state.wsize) {
            state.wnext = 0;
          }
          if (state.whave < state.wsize) {
            state.whave += dist;
          }
        }
      }
      return 0;
    };
    var inflate = (strm, flush) => {
      let state;
      let input, output;
      let next;
      let put;
      let have, left;
      let hold;
      let bits;
      let _in, _out;
      let copy;
      let from;
      let from_source;
      let here = 0;
      let here_bits, here_op, here_val;
      let last_bits, last_op, last_val;
      let len;
      let ret;
      const hbuf = new Uint8Array(4);
      let opts;
      let n;
      const order = (
        /* permutation of code lengths */
        new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])
      );
      if (inflateStateCheck(strm) || !strm.output || !strm.input && strm.avail_in !== 0) {
        return Z_STREAM_ERROR;
      }
      state = strm.state;
      if (state.mode === TYPE) {
        state.mode = TYPEDO;
      }
      put = strm.next_out;
      output = strm.output;
      left = strm.avail_out;
      next = strm.next_in;
      input = strm.input;
      have = strm.avail_in;
      hold = state.hold;
      bits = state.bits;
      _in = have;
      _out = left;
      ret = Z_OK;
      inf_leave:
        for (; ; ) {
          switch (state.mode) {
            case HEAD:
              if (state.wrap === 0) {
                state.mode = TYPEDO;
                break;
              }
              while (bits < 16) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (state.wrap & 2 && hold === 35615) {
                if (state.wbits === 0) {
                  state.wbits = 15;
                }
                state.check = 0;
                hbuf[0] = hold & 255;
                hbuf[1] = hold >>> 8 & 255;
                state.check = crc32(state.check, hbuf, 2, 0);
                hold = 0;
                bits = 0;
                state.mode = FLAGS;
                break;
              }
              if (state.head) {
                state.head.done = false;
              }
              if (!(state.wrap & 1) || /* check if zlib header allowed */
              (((hold & 255) << 8) + (hold >> 8)) % 31) {
                strm.msg = "incorrect header check";
                state.mode = BAD;
                break;
              }
              if ((hold & 15) !== Z_DEFLATED) {
                strm.msg = "unknown compression method";
                state.mode = BAD;
                break;
              }
              hold >>>= 4;
              bits -= 4;
              len = (hold & 15) + 8;
              if (state.wbits === 0) {
                state.wbits = len;
              }
              if (len > 15 || len > state.wbits) {
                strm.msg = "invalid window size";
                state.mode = BAD;
                break;
              }
              state.dmax = 1 << state.wbits;
              state.flags = 0;
              strm.adler = state.check = 1;
              state.mode = hold & 512 ? DICTID : TYPE;
              hold = 0;
              bits = 0;
              break;
            case FLAGS:
              while (bits < 16) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.flags = hold;
              if ((state.flags & 255) !== Z_DEFLATED) {
                strm.msg = "unknown compression method";
                state.mode = BAD;
                break;
              }
              if (state.flags & 57344) {
                strm.msg = "unknown header flags set";
                state.mode = BAD;
                break;
              }
              if (state.head) {
                state.head.text = hold >> 8 & 1;
              }
              if (state.flags & 512 && state.wrap & 4) {
                hbuf[0] = hold & 255;
                hbuf[1] = hold >>> 8 & 255;
                state.check = crc32(state.check, hbuf, 2, 0);
              }
              hold = 0;
              bits = 0;
              state.mode = TIME;
            /* falls through */
            case TIME:
              while (bits < 32) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (state.head) {
                state.head.time = hold;
              }
              if (state.flags & 512 && state.wrap & 4) {
                hbuf[0] = hold & 255;
                hbuf[1] = hold >>> 8 & 255;
                hbuf[2] = hold >>> 16 & 255;
                hbuf[3] = hold >>> 24 & 255;
                state.check = crc32(state.check, hbuf, 4, 0);
              }
              hold = 0;
              bits = 0;
              state.mode = OS;
            /* falls through */
            case OS:
              while (bits < 16) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (state.head) {
                state.head.xflags = hold & 255;
                state.head.os = hold >> 8;
              }
              if (state.flags & 512 && state.wrap & 4) {
                hbuf[0] = hold & 255;
                hbuf[1] = hold >>> 8 & 255;
                state.check = crc32(state.check, hbuf, 2, 0);
              }
              hold = 0;
              bits = 0;
              state.mode = EXLEN;
            /* falls through */
            case EXLEN:
              if (state.flags & 1024) {
                while (bits < 16) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.length = hold;
                if (state.head) {
                  state.head.extra_len = hold;
                }
                if (state.flags & 512 && state.wrap & 4) {
                  hbuf[0] = hold & 255;
                  hbuf[1] = hold >>> 8 & 255;
                  state.check = crc32(state.check, hbuf, 2, 0);
                }
                hold = 0;
                bits = 0;
              } else if (state.head) {
                state.head.extra = null;
              }
              state.mode = EXTRA;
            /* falls through */
            case EXTRA:
              if (state.flags & 1024) {
                copy = state.length;
                if (copy > have) {
                  copy = have;
                }
                if (copy) {
                  if (state.head) {
                    len = state.head.extra_len - state.length;
                    if (!state.head.extra) {
                      state.head.extra = new Uint8Array(state.head.extra_len);
                    }
                    state.head.extra.set(
                      input.subarray(
                        next,
                        // extra field is limited to 65536 bytes
                        // - no need for additional size check
                        next + copy
                      ),
                      /*len + copy > state.head.extra_max - len ? state.head.extra_max : copy,*/
                      len
                    );
                  }
                  if (state.flags & 512 && state.wrap & 4) {
                    state.check = crc32(state.check, input, copy, next);
                  }
                  have -= copy;
                  next += copy;
                  state.length -= copy;
                }
                if (state.length) {
                  break inf_leave;
                }
              }
              state.length = 0;
              state.mode = NAME;
            /* falls through */
            case NAME:
              if (state.flags & 2048) {
                if (have === 0) {
                  break inf_leave;
                }
                copy = 0;
                do {
                  len = input[next + copy++];
                  if (state.head && len && state.length < 65536) {
                    state.head.name += String.fromCharCode(len);
                  }
                } while (len && copy < have);
                if (state.flags & 512 && state.wrap & 4) {
                  state.check = crc32(state.check, input, copy, next);
                }
                have -= copy;
                next += copy;
                if (len) {
                  break inf_leave;
                }
              } else if (state.head) {
                state.head.name = null;
              }
              state.length = 0;
              state.mode = COMMENT;
            /* falls through */
            case COMMENT:
              if (state.flags & 4096) {
                if (have === 0) {
                  break inf_leave;
                }
                copy = 0;
                do {
                  len = input[next + copy++];
                  if (state.head && len && state.length < 65536) {
                    state.head.comment += String.fromCharCode(len);
                  }
                } while (len && copy < have);
                if (state.flags & 512 && state.wrap & 4) {
                  state.check = crc32(state.check, input, copy, next);
                }
                have -= copy;
                next += copy;
                if (len) {
                  break inf_leave;
                }
              } else if (state.head) {
                state.head.comment = null;
              }
              state.mode = HCRC;
            /* falls through */
            case HCRC:
              if (state.flags & 512) {
                while (bits < 16) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (state.wrap & 4 && hold !== (state.check & 65535)) {
                  strm.msg = "header crc mismatch";
                  state.mode = BAD;
                  break;
                }
                hold = 0;
                bits = 0;
              }
              if (state.head) {
                state.head.hcrc = state.flags >> 9 & 1;
                state.head.done = true;
              }
              strm.adler = state.check = 0;
              state.mode = TYPE;
              break;
            case DICTID:
              while (bits < 32) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              strm.adler = state.check = zswap32(hold);
              hold = 0;
              bits = 0;
              state.mode = DICT;
            /* falls through */
            case DICT:
              if (state.havedict === 0) {
                strm.next_out = put;
                strm.avail_out = left;
                strm.next_in = next;
                strm.avail_in = have;
                state.hold = hold;
                state.bits = bits;
                return Z_NEED_DICT;
              }
              strm.adler = state.check = 1;
              state.mode = TYPE;
            /* falls through */
            case TYPE:
              if (flush === Z_BLOCK || flush === Z_TREES) {
                break inf_leave;
              }
            /* falls through */
            case TYPEDO:
              if (state.last) {
                hold >>>= bits & 7;
                bits -= bits & 7;
                state.mode = CHECK;
                break;
              }
              while (bits < 3) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.last = hold & 1;
              hold >>>= 1;
              bits -= 1;
              switch (hold & 3) {
                case 0:
                  state.mode = STORED;
                  break;
                case 1:
                  fixedtables(state);
                  state.mode = LEN_;
                  if (flush === Z_TREES) {
                    hold >>>= 2;
                    bits -= 2;
                    break inf_leave;
                  }
                  break;
                case 2:
                  state.mode = TABLE;
                  break;
                case 3:
                  strm.msg = "invalid block type";
                  state.mode = BAD;
              }
              hold >>>= 2;
              bits -= 2;
              break;
            case STORED:
              hold >>>= bits & 7;
              bits -= bits & 7;
              while (bits < 32) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if ((hold & 65535) !== (hold >>> 16 ^ 65535)) {
                strm.msg = "invalid stored block lengths";
                state.mode = BAD;
                break;
              }
              state.length = hold & 65535;
              hold = 0;
              bits = 0;
              state.mode = COPY_;
              if (flush === Z_TREES) {
                break inf_leave;
              }
            /* falls through */
            case COPY_:
              state.mode = COPY;
            /* falls through */
            case COPY:
              copy = state.length;
              if (copy) {
                if (copy > have) {
                  copy = have;
                }
                if (copy > left) {
                  copy = left;
                }
                if (copy === 0) {
                  break inf_leave;
                }
                output.set(input.subarray(next, next + copy), put);
                have -= copy;
                next += copy;
                left -= copy;
                put += copy;
                state.length -= copy;
                break;
              }
              state.mode = TYPE;
              break;
            case TABLE:
              while (bits < 14) {
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.nlen = (hold & 31) + 257;
              hold >>>= 5;
              bits -= 5;
              state.ndist = (hold & 31) + 1;
              hold >>>= 5;
              bits -= 5;
              state.ncode = (hold & 15) + 4;
              hold >>>= 4;
              bits -= 4;
              if (state.nlen > 286 || state.ndist > 30) {
                strm.msg = "too many length or distance symbols";
                state.mode = BAD;
                break;
              }
              state.have = 0;
              state.mode = LENLENS;
            /* falls through */
            case LENLENS:
              while (state.have < state.ncode) {
                while (bits < 3) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.lens[order[state.have++]] = hold & 7;
                hold >>>= 3;
                bits -= 3;
              }
              while (state.have < 19) {
                state.lens[order[state.have++]] = 0;
              }
              state.lencode = state.lendyn;
              state.lenbits = 7;
              opts = { bits: state.lenbits };
              ret = inflate_table(CODES, state.lens, 0, 19, state.lencode, 0, state.work, opts);
              state.lenbits = opts.bits;
              if (ret) {
                strm.msg = "invalid code lengths set";
                state.mode = BAD;
                break;
              }
              state.have = 0;
              state.mode = CODELENS;
            /* falls through */
            case CODELENS:
              while (state.have < state.nlen + state.ndist) {
                for (; ; ) {
                  here = state.lencode[hold & (1 << state.lenbits) - 1];
                  here_bits = here >>> 24;
                  here_op = here >>> 16 & 255;
                  here_val = here & 65535;
                  if (here_bits <= bits) {
                    break;
                  }
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (here_val < 16) {
                  hold >>>= here_bits;
                  bits -= here_bits;
                  state.lens[state.have++] = here_val;
                } else {
                  if (here_val === 16) {
                    n = here_bits + 2;
                    while (bits < n) {
                      if (have === 0) {
                        break inf_leave;
                      }
                      have--;
                      hold += input[next++] << bits;
                      bits += 8;
                    }
                    hold >>>= here_bits;
                    bits -= here_bits;
                    if (state.have === 0) {
                      strm.msg = "invalid bit length repeat";
                      state.mode = BAD;
                      break;
                    }
                    len = state.lens[state.have - 1];
                    copy = 3 + (hold & 3);
                    hold >>>= 2;
                    bits -= 2;
                  } else if (here_val === 17) {
                    n = here_bits + 3;
                    while (bits < n) {
                      if (have === 0) {
                        break inf_leave;
                      }
                      have--;
                      hold += input[next++] << bits;
                      bits += 8;
                    }
                    hold >>>= here_bits;
                    bits -= here_bits;
                    len = 0;
                    copy = 3 + (hold & 7);
                    hold >>>= 3;
                    bits -= 3;
                  } else {
                    n = here_bits + 7;
                    while (bits < n) {
                      if (have === 0) {
                        break inf_leave;
                      }
                      have--;
                      hold += input[next++] << bits;
                      bits += 8;
                    }
                    hold >>>= here_bits;
                    bits -= here_bits;
                    len = 0;
                    copy = 11 + (hold & 127);
                    hold >>>= 7;
                    bits -= 7;
                  }
                  if (state.have + copy > state.nlen + state.ndist) {
                    strm.msg = "invalid bit length repeat";
                    state.mode = BAD;
                    break;
                  }
                  while (copy--) {
                    state.lens[state.have++] = len;
                  }
                }
              }
              if (state.mode === BAD) {
                break;
              }
              if (state.lens[256] === 0) {
                strm.msg = "invalid code -- missing end-of-block";
                state.mode = BAD;
                break;
              }
              state.lenbits = 9;
              opts = { bits: state.lenbits };
              ret = inflate_table(LENS, state.lens, 0, state.nlen, state.lencode, 0, state.work, opts);
              state.lenbits = opts.bits;
              if (ret) {
                strm.msg = "invalid literal/lengths set";
                state.mode = BAD;
                break;
              }
              state.distbits = 6;
              state.distcode = state.distdyn;
              opts = { bits: state.distbits };
              ret = inflate_table(DISTS, state.lens, state.nlen, state.ndist, state.distcode, 0, state.work, opts);
              state.distbits = opts.bits;
              if (ret) {
                strm.msg = "invalid distances set";
                state.mode = BAD;
                break;
              }
              state.mode = LEN_;
              if (flush === Z_TREES) {
                break inf_leave;
              }
            /* falls through */
            case LEN_:
              state.mode = LEN;
            /* falls through */
            case LEN:
              if (have >= 6 && left >= 258) {
                strm.next_out = put;
                strm.avail_out = left;
                strm.next_in = next;
                strm.avail_in = have;
                state.hold = hold;
                state.bits = bits;
                inflate_fast(strm, _out);
                put = strm.next_out;
                output = strm.output;
                left = strm.avail_out;
                next = strm.next_in;
                input = strm.input;
                have = strm.avail_in;
                hold = state.hold;
                bits = state.bits;
                if (state.mode === TYPE) {
                  state.back = -1;
                }
                break;
              }
              state.back = 0;
              for (; ; ) {
                here = state.lencode[hold & (1 << state.lenbits) - 1];
                here_bits = here >>> 24;
                here_op = here >>> 16 & 255;
                here_val = here & 65535;
                if (here_bits <= bits) {
                  break;
                }
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (here_op && (here_op & 240) === 0) {
                last_bits = here_bits;
                last_op = here_op;
                last_val = here_val;
                for (; ; ) {
                  here = state.lencode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                  here_bits = here >>> 24;
                  here_op = here >>> 16 & 255;
                  here_val = here & 65535;
                  if (last_bits + here_bits <= bits) {
                    break;
                  }
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                hold >>>= last_bits;
                bits -= last_bits;
                state.back += last_bits;
              }
              hold >>>= here_bits;
              bits -= here_bits;
              state.back += here_bits;
              state.length = here_val;
              if (here_op === 0) {
                state.mode = LIT;
                break;
              }
              if (here_op & 32) {
                state.back = -1;
                state.mode = TYPE;
                break;
              }
              if (here_op & 64) {
                strm.msg = "invalid literal/length code";
                state.mode = BAD;
                break;
              }
              state.extra = here_op & 15;
              state.mode = LENEXT;
            /* falls through */
            case LENEXT:
              if (state.extra) {
                n = state.extra;
                while (bits < n) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.length += hold & (1 << state.extra) - 1;
                hold >>>= state.extra;
                bits -= state.extra;
                state.back += state.extra;
              }
              state.was = state.length;
              state.mode = DIST;
            /* falls through */
            case DIST:
              for (; ; ) {
                here = state.distcode[hold & (1 << state.distbits) - 1];
                here_bits = here >>> 24;
                here_op = here >>> 16 & 255;
                here_val = here & 65535;
                if (here_bits <= bits) {
                  break;
                }
                if (have === 0) {
                  break inf_leave;
                }
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if ((here_op & 240) === 0) {
                last_bits = here_bits;
                last_op = here_op;
                last_val = here_val;
                for (; ; ) {
                  here = state.distcode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                  here_bits = here >>> 24;
                  here_op = here >>> 16 & 255;
                  here_val = here & 65535;
                  if (last_bits + here_bits <= bits) {
                    break;
                  }
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                hold >>>= last_bits;
                bits -= last_bits;
                state.back += last_bits;
              }
              hold >>>= here_bits;
              bits -= here_bits;
              state.back += here_bits;
              if (here_op & 64) {
                strm.msg = "invalid distance code";
                state.mode = BAD;
                break;
              }
              state.offset = here_val;
              state.extra = here_op & 15;
              state.mode = DISTEXT;
            /* falls through */
            case DISTEXT:
              if (state.extra) {
                n = state.extra;
                while (bits < n) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                state.offset += hold & (1 << state.extra) - 1;
                hold >>>= state.extra;
                bits -= state.extra;
                state.back += state.extra;
              }
              if (state.offset > state.dmax) {
                strm.msg = "invalid distance too far back";
                state.mode = BAD;
                break;
              }
              state.mode = MATCH;
            /* falls through */
            case MATCH:
              if (left === 0) {
                break inf_leave;
              }
              copy = _out - left;
              if (state.offset > copy) {
                copy = state.offset - copy;
                if (copy > state.whave) {
                  if (state.sane) {
                    strm.msg = "invalid distance too far back";
                    state.mode = BAD;
                    break;
                  }
                }
                if (copy > state.wnext) {
                  copy -= state.wnext;
                  from = state.wsize - copy;
                } else {
                  from = state.wnext - copy;
                }
                if (copy > state.length) {
                  copy = state.length;
                }
                from_source = state.window;
              } else {
                from_source = output;
                from = put - state.offset;
                copy = state.length;
              }
              if (copy > left) {
                copy = left;
              }
              left -= copy;
              state.length -= copy;
              do {
                output[put++] = from_source[from++];
              } while (--copy);
              if (state.length === 0) {
                state.mode = LEN;
              }
              break;
            case LIT:
              if (left === 0) {
                break inf_leave;
              }
              output[put++] = state.length;
              left--;
              state.mode = LEN;
              break;
            case CHECK:
              if (state.wrap) {
                while (bits < 32) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold |= input[next++] << bits;
                  bits += 8;
                }
                _out -= left;
                strm.total_out += _out;
                state.total += _out;
                if (state.wrap & 4 && _out) {
                  strm.adler = state.check = /*UPDATE_CHECK(state.check, put - _out, _out);*/
                  state.flags ? crc32(state.check, output, _out, put - _out) : adler32(state.check, output, _out, put - _out);
                }
                _out = left;
                if (state.wrap & 4 && (state.flags ? hold : zswap32(hold)) !== state.check) {
                  strm.msg = "incorrect data check";
                  state.mode = BAD;
                  break;
                }
                hold = 0;
                bits = 0;
              }
              state.mode = LENGTH;
            /* falls through */
            case LENGTH:
              if (state.wrap && state.flags) {
                while (bits < 32) {
                  if (have === 0) {
                    break inf_leave;
                  }
                  have--;
                  hold += input[next++] << bits;
                  bits += 8;
                }
                if (state.wrap & 4 && hold !== (state.total & 4294967295)) {
                  strm.msg = "incorrect length check";
                  state.mode = BAD;
                  break;
                }
                hold = 0;
                bits = 0;
              }
              state.mode = DONE;
            /* falls through */
            case DONE:
              ret = Z_STREAM_END;
              break inf_leave;
            case BAD:
              ret = Z_DATA_ERROR;
              break inf_leave;
            case MEM:
              return Z_MEM_ERROR;
            case SYNC:
            /* falls through */
            default:
              return Z_STREAM_ERROR;
          }
        }
      strm.next_out = put;
      strm.avail_out = left;
      strm.next_in = next;
      strm.avail_in = have;
      state.hold = hold;
      state.bits = bits;
      if (state.wsize || _out !== strm.avail_out && state.mode < BAD && (state.mode < CHECK || flush !== Z_FINISH)) {
        if (updatewindow(strm, strm.output, strm.next_out, _out - strm.avail_out)) {
          state.mode = MEM;
          return Z_MEM_ERROR;
        }
      }
      _in -= strm.avail_in;
      _out -= strm.avail_out;
      strm.total_in += _in;
      strm.total_out += _out;
      state.total += _out;
      if (state.wrap & 4 && _out) {
        strm.adler = state.check = /*UPDATE_CHECK(state.check, strm.next_out - _out, _out);*/
        state.flags ? crc32(state.check, output, _out, strm.next_out - _out) : adler32(state.check, output, _out, strm.next_out - _out);
      }
      strm.data_type = state.bits + (state.last ? 64 : 0) + (state.mode === TYPE ? 128 : 0) + (state.mode === LEN_ || state.mode === COPY_ ? 256 : 0);
      if ((_in === 0 && _out === 0 || flush === Z_FINISH) && ret === Z_OK) {
        ret = Z_BUF_ERROR;
      }
      return ret;
    };
    var inflateEnd = (strm) => {
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      let state = strm.state;
      if (state.window) {
        state.window = null;
      }
      strm.state = null;
      return Z_OK;
    };
    var inflateGetHeader = (strm, head) => {
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      const state = strm.state;
      if ((state.wrap & 2) === 0) {
        return Z_STREAM_ERROR;
      }
      state.head = head;
      head.done = false;
      return Z_OK;
    };
    var inflateSetDictionary = (strm, dictionary) => {
      const dictLength = dictionary.length;
      let state;
      let dictid;
      let ret;
      if (inflateStateCheck(strm)) {
        return Z_STREAM_ERROR;
      }
      state = strm.state;
      if (state.wrap !== 0 && state.mode !== DICT) {
        return Z_STREAM_ERROR;
      }
      if (state.mode === DICT) {
        dictid = 1;
        dictid = adler32(dictid, dictionary, dictLength, 0);
        if (dictid !== state.check) {
          return Z_DATA_ERROR;
        }
      }
      ret = updatewindow(strm, dictionary, dictLength, dictLength);
      if (ret) {
        state.mode = MEM;
        return Z_MEM_ERROR;
      }
      state.havedict = 1;
      return Z_OK;
    };
    module.exports.inflateReset = inflateReset;
    module.exports.inflateReset2 = inflateReset2;
    module.exports.inflateResetKeep = inflateResetKeep;
    module.exports.inflateInit = inflateInit;
    module.exports.inflateInit2 = inflateInit2;
    module.exports.inflate = inflate;
    module.exports.inflateEnd = inflateEnd;
    module.exports.inflateGetHeader = inflateGetHeader;
    module.exports.inflateSetDictionary = inflateSetDictionary;
    module.exports.inflateInfo = "pako inflate (from Nodeca project)";
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/gzheader.js
var require_gzheader = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/zlib/gzheader.js"(exports, module) {
    "use strict";
    function GZheader() {
      this.text = 0;
      this.time = 0;
      this.xflags = 0;
      this.os = 0;
      this.extra = null;
      this.extra_len = 0;
      this.name = "";
      this.comment = "";
      this.hcrc = 0;
      this.done = false;
    }
    module.exports = GZheader;
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/inflate.js
var require_inflate2 = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/lib/inflate.js"(exports, module) {
    "use strict";
    var zlib_inflate = require_inflate();
    var utils = require_common2();
    var strings = require_strings();
    var msg = require_messages();
    var ZStream = require_zstream();
    var GZheader = require_gzheader();
    var toString = Object.prototype.toString;
    var {
      Z_NO_FLUSH,
      Z_FINISH,
      Z_OK,
      Z_STREAM_END,
      Z_NEED_DICT,
      Z_STREAM_ERROR,
      Z_DATA_ERROR,
      Z_MEM_ERROR,
      Z_BUF_ERROR
    } = require_constants();
    var defaultOptions = {
      chunkSize: 1024 * 64,
      windowBits: 15,
      to: ""
    };
    function Inflate(options) {
      this.options = utils.assign({}, defaultOptions, options || {});
      const opt = this.options;
      if (opt.raw && opt.windowBits >= 0 && opt.windowBits < 16) {
        opt.windowBits = -opt.windowBits;
        if (opt.windowBits === 0) {
          opt.windowBits = -15;
        }
      }
      if (opt.windowBits >= 0 && opt.windowBits < 16 && !(options && options.windowBits)) {
        opt.windowBits += 32;
      }
      if (opt.windowBits > 15 && opt.windowBits < 48) {
        if ((opt.windowBits & 15) === 0) {
          opt.windowBits |= 15;
        }
      }
      this.err = 0;
      this.msg = "";
      this.ended = false;
      this.chunks = [];
      this.strm = new ZStream();
      this.strm.avail_out = 0;
      let status = zlib_inflate.inflateInit2(
        this.strm,
        opt.windowBits
      );
      if (status !== Z_OK) {
        throw new Error(msg[status]);
      }
      this.header = new GZheader();
      zlib_inflate.inflateGetHeader(this.strm, this.header);
      if (opt.dictionary) {
        if (typeof opt.dictionary === "string") {
          opt.dictionary = strings.string2buf(opt.dictionary);
        } else if (toString.call(opt.dictionary) === "[object ArrayBuffer]") {
          opt.dictionary = new Uint8Array(opt.dictionary);
        }
        if (opt.raw) {
          status = zlib_inflate.inflateSetDictionary(this.strm, opt.dictionary);
          if (status !== Z_OK) {
            throw new Error(msg[status]);
          }
        }
      }
    }
    Inflate.prototype.push = function(data, flush_mode) {
      const strm = this.strm;
      const chunkSize = this.options.chunkSize;
      const dictionary = this.options.dictionary;
      let status, _flush_mode, last_avail_out;
      if (this.ended) return false;
      if (flush_mode === ~~flush_mode) _flush_mode = flush_mode;
      else _flush_mode = flush_mode === true ? Z_FINISH : Z_NO_FLUSH;
      if (toString.call(data) === "[object ArrayBuffer]") {
        strm.input = new Uint8Array(data);
      } else {
        strm.input = data;
      }
      strm.next_in = 0;
      strm.avail_in = strm.input.length;
      for (; ; ) {
        if (strm.avail_out === 0) {
          strm.output = new Uint8Array(chunkSize);
          strm.next_out = 0;
          strm.avail_out = chunkSize;
        }
        status = zlib_inflate.inflate(strm, _flush_mode);
        if (status === Z_NEED_DICT && dictionary) {
          status = zlib_inflate.inflateSetDictionary(strm, dictionary);
          if (status === Z_OK) {
            status = zlib_inflate.inflate(strm, _flush_mode);
          } else if (status === Z_DATA_ERROR) {
            status = Z_NEED_DICT;
          }
        }
        while (strm.avail_in > 0 && status === Z_STREAM_END && strm.state.wrap & 2 && strm.state.flags !== 0 && strm.input[strm.next_in] !== 0) {
          zlib_inflate.inflateReset(strm);
          status = zlib_inflate.inflate(strm, _flush_mode);
        }
        switch (status) {
          case Z_STREAM_ERROR:
          case Z_DATA_ERROR:
          case Z_NEED_DICT:
          case Z_MEM_ERROR:
            this.onEnd(status);
            this.ended = true;
            return false;
        }
        last_avail_out = strm.avail_out;
        if (strm.next_out) {
          if (strm.avail_out === 0 || status === Z_STREAM_END || _flush_mode > 0) {
            if (this.options.to === "string") {
              let next_out_utf8 = strings.utf8border(strm.output, strm.next_out);
              let tail = strm.next_out - next_out_utf8;
              let utf8str = strings.buf2string(strm.output, next_out_utf8);
              strm.next_out = tail;
              strm.avail_out = chunkSize - tail;
              if (tail) strm.output.set(strm.output.subarray(next_out_utf8, next_out_utf8 + tail), 0);
              this.onData(utf8str);
            } else {
              this.onData(strm.output.length === strm.next_out ? strm.output : strm.output.subarray(0, strm.next_out));
              strm.avail_out = 0;
              strm.next_out = 0;
            }
          }
        }
        if ((status === Z_OK || status === Z_BUF_ERROR) && last_avail_out === 0) continue;
        if (status === Z_STREAM_END) {
          status = zlib_inflate.inflateEnd(this.strm);
          this.onEnd(status);
          this.ended = true;
          return true;
        }
        if (strm.avail_in === 0) {
          if (_flush_mode === Z_FINISH) {
            status = zlib_inflate.inflateEnd(this.strm);
            this.onEnd(status === Z_OK ? Z_BUF_ERROR : status);
            this.ended = true;
            return false;
          }
          break;
        }
      }
      return true;
    };
    Inflate.prototype.onData = function(chunk) {
      this.chunks.push(chunk);
    };
    Inflate.prototype.onEnd = function(status) {
      if (status === Z_OK) {
        if (this.options.to === "string") {
          this.result = this.chunks.join("");
        } else {
          this.result = utils.flattenChunks(this.chunks);
        }
      }
      this.chunks = [];
      this.err = status;
      this.msg = this.strm.msg;
    };
    function inflate(input, options) {
      const inflator = new Inflate(options);
      inflator.push(input, true);
      if (inflator.err) throw inflator.msg || msg[inflator.err];
      return inflator.result;
    }
    function inflateRaw(input, options) {
      options = options || {};
      options.raw = true;
      return inflate(input, options);
    }
    module.exports.Inflate = Inflate;
    module.exports.inflate = inflate;
    module.exports.inflateRaw = inflateRaw;
    module.exports.ungzip = inflate;
    module.exports.constants = require_constants();
  }
});

// sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/index.js
var require_pako = __commonJS({
  "sdk/node_modules/.pnpm/pako@2.2.0/node_modules/pako/index.js"(exports, module) {
    "use strict";
    var { Deflate, deflate, deflateRaw, gzip } = require_deflate2();
    var { Inflate, inflate, inflateRaw, ungzip } = require_inflate2();
    var constants = require_constants();
    module.exports.Deflate = Deflate;
    module.exports.deflate = deflate;
    module.exports.deflateRaw = deflateRaw;
    module.exports.gzip = gzip;
    module.exports.Inflate = Inflate;
    module.exports.inflate = inflate;
    module.exports.inflateRaw = inflateRaw;
    module.exports.ungzip = ungzip;
    module.exports.constants = constants;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/case.js
var require_case = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/case.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.toCamelCase = void 0;
    function toCamelCase(input) {
      if (!input)
        return input;
      const spaced = input.replace(/[^A-Za-z0-9]+/g, " ").replace(/([a-z][\d]*)([A-Z])/g, "$1 $2").replace(/([A-Z][A-Z\d]*)([A-Z][a-z])/g, "$1 $2").trim();
      if (!spaced)
        return "";
      return spaced.split(/\s+/).map((word, i) => i === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join("");
    }
    exports.toCamelCase = toCamelCase;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/idl.js
var require_idl = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/idl.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.handleDefinedFields = exports.convertIdlToCamelCase = exports.decodeMetadataData = exports.uncompressMetadataData = exports.decodeIdlAccountRaw = exports.decodeIdlAccount = exports.seed = exports.idlAddress = exports.Format = exports.MetadataEncoding = exports.MetadataCompression = exports.FORMAT_JSON = exports.isCompositeAccounts = void 0;
    var index_js_1 = require_bytes();
    var pako_1 = require_pako();
    var case_js_1 = require_case();
    var buffer_1 = __require("buffer");
    var web3_js_1 = __require("@solana/web3.js");
    function isCompositeAccounts(accountItem) {
      return "accounts" in accountItem;
    }
    exports.isCompositeAccounts = isCompositeAccounts;
    var PROGRAM_METADATA_PROGRAM_ID = new web3_js_1.PublicKey("ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S");
    var IDL_METADATA_SEED = "idl";
    var ACCOUNT_DISCRIMINATOR_METADATA = 2;
    var DATA_SOURCE_DIRECT = 0;
    exports.FORMAT_JSON = 1;
    var SEED_SIZE = 16;
    var DATA_LENGTH_SIZE = 4;
    var DATA_LENGTH_PADDING = 5;
    var PUBKEY_SIZE = 32;
    var ZEROABLE_OPTION_PUBKEY_SIZE = 32;
    var METADATA_HEADER_SIZE = 1 + PUBKEY_SIZE + ZEROABLE_OPTION_PUBKEY_SIZE + 1 + 1 + SEED_SIZE + 1 + 1 + 1 + 1;
    var MetadataCompression;
    (function(MetadataCompression2) {
      MetadataCompression2[MetadataCompression2["None"] = 0] = "None";
      MetadataCompression2[MetadataCompression2["Gzip"] = 1] = "Gzip";
      MetadataCompression2[MetadataCompression2["Zlib"] = 2] = "Zlib";
    })(MetadataCompression = exports.MetadataCompression || (exports.MetadataCompression = {}));
    var MetadataEncoding;
    (function(MetadataEncoding2) {
      MetadataEncoding2[MetadataEncoding2["None"] = 0] = "None";
      MetadataEncoding2[MetadataEncoding2["Utf8"] = 1] = "Utf8";
      MetadataEncoding2[MetadataEncoding2["Base58"] = 2] = "Base58";
      MetadataEncoding2[MetadataEncoding2["Base64"] = 3] = "Base64";
    })(MetadataEncoding = exports.MetadataEncoding || (exports.MetadataEncoding = {}));
    var Format;
    (function(Format2) {
      Format2[Format2["None"] = 0] = "None";
      Format2[Format2["Json"] = 1] = "Json";
      Format2[Format2["Yaml"] = 2] = "Yaml";
      Format2[Format2["Toml"] = 3] = "Toml";
    })(Format = exports.Format || (exports.Format = {}));
    function encodeMetadataSeed(seed2) {
      const encodedSeed = buffer_1.Buffer.from(index_js_1.utf8.encode(seed2));
      if (encodedSeed.length > SEED_SIZE) {
        throw new Error(`Metadata seed '${seed2}' exceeds ${SEED_SIZE} bytes`);
      }
      const paddedSeed = buffer_1.Buffer.alloc(SEED_SIZE);
      encodedSeed.copy(paddedSeed);
      return paddedSeed;
    }
    function idlAddress(programId) {
      return web3_js_1.PublicKey.findProgramAddressSync([
        programId.toBuffer(),
        buffer_1.Buffer.alloc(0),
        encodeMetadataSeed(IDL_METADATA_SEED)
      ], PROGRAM_METADATA_PROGRAM_ID)[0];
    }
    exports.idlAddress = idlAddress;
    function seed() {
      return "idl";
    }
    exports.seed = seed;
    function decodeIdlAccount(data) {
      const { data: rawData, compression, encoding } = decodeIdlAccountRaw(data);
      const decoded = decodeMetadataData(uncompressMetadataData(rawData, compression), encoding);
      return JSON.parse(decoded);
    }
    exports.decodeIdlAccount = decodeIdlAccount;
    function decodeIdlAccountRaw(data) {
      const minimumSize = METADATA_HEADER_SIZE + DATA_LENGTH_SIZE + DATA_LENGTH_PADDING;
      if (data.length < minimumSize) {
        throw new Error("Metadata account is too small");
      }
      let offset = 0;
      const discriminator = data.readUInt8(offset);
      if (discriminator !== ACCOUNT_DISCRIMINATOR_METADATA) {
        throw new Error(`Invalid metadata account discriminator: ${discriminator.toString()}`);
      }
      offset += 1;
      const program = new web3_js_1.PublicKey(data.subarray(offset, offset + PUBKEY_SIZE));
      offset += PUBKEY_SIZE;
      const authorityBytes = data.subarray(offset, offset + ZEROABLE_OPTION_PUBKEY_SIZE);
      const authority = authorityBytes.every((b) => b === 0) ? null : new web3_js_1.PublicKey(authorityBytes);
      offset += ZEROABLE_OPTION_PUBKEY_SIZE;
      const mutable = Boolean(data.readUInt8(offset));
      offset += 1;
      const canonical = Boolean(data.readUInt8(offset));
      offset += 1;
      const seed2 = index_js_1.utf8.decode(data.subarray(offset, offset + SEED_SIZE));
      offset += SEED_SIZE;
      const encoding = data.readUInt8(offset);
      offset += 1;
      const compression = data.readUInt8(offset);
      offset += 1;
      const format = data.readUInt8(offset);
      if (format !== Format.Json) {
        throw new Error(`IDL has data format '${format}', only JSON IDLs (${Format.Json}) are supported`);
      }
      offset += 1;
      const dataSource = data.readUInt8(offset);
      if (dataSource !== DATA_SOURCE_DIRECT) {
        throw new Error(`IDL has source '${dataSource}', only directly embedded data (${DATA_SOURCE_DIRECT}) is supported`);
      }
      offset += 1;
      const dataLength = data.readUInt32LE(offset);
      offset += DATA_LENGTH_SIZE + DATA_LENGTH_PADDING;
      if (data.length < offset + dataLength) {
        throw new Error("Metadata account data is truncated");
      }
      return {
        discriminator,
        program,
        authority,
        mutable,
        canonical,
        seed: seed2,
        encoding,
        compression,
        format,
        dataSource,
        dataLength,
        data: data.subarray(offset, offset + dataLength)
      };
    }
    exports.decodeIdlAccountRaw = decodeIdlAccountRaw;
    function uncompressMetadataData(data, compression) {
      switch (compression) {
        case MetadataCompression.None:
          return data;
        case MetadataCompression.Gzip:
          return buffer_1.Buffer.from((0, pako_1.ungzip)(data));
        case MetadataCompression.Zlib:
          return buffer_1.Buffer.from((0, pako_1.inflate)(data));
        default:
          throw new Error(`Unsupported metadata compression: ${String(compression)}`);
      }
    }
    exports.uncompressMetadataData = uncompressMetadataData;
    function decodeMetadataData(data, encoding) {
      switch (encoding) {
        // 'None' is actually hex-encoded
        case MetadataEncoding.None:
          return data.toString("hex");
        case MetadataEncoding.Utf8:
          return index_js_1.utf8.decode(data);
        case MetadataEncoding.Base58:
          return index_js_1.bs58.encode(data);
        case MetadataEncoding.Base64:
          return data.toString("base64");
        default:
          throw new Error(`Unsupported metadata encoding: ${String(encoding)}`);
      }
    }
    exports.decodeMetadataData = decodeMetadataData;
    function convertIdlToCamelCase2(idl) {
      const KEYS_TO_CONVERT = ["name", "path", "account", "relations", "generic"];
      const toCamelCasePath = (s) => s.split(".").map((part) => (0, case_js_1.toCamelCase)(part)).join(".");
      const recursivelyConvertNamesToCamelCase = (obj) => {
        for (const key2 in obj) {
          const val = obj[key2];
          if (KEYS_TO_CONVERT.includes(key2)) {
            obj[key2] = Array.isArray(val) ? val.map(toCamelCasePath) : toCamelCasePath(val);
          } else if (typeof val === "object") {
            recursivelyConvertNamesToCamelCase(val);
          }
        }
      };
      const camelCasedIdl = structuredClone(idl);
      recursivelyConvertNamesToCamelCase(camelCasedIdl);
      return camelCasedIdl;
    }
    exports.convertIdlToCamelCase = convertIdlToCamelCase2;
    function handleDefinedFields(fields, unitCb, namedCb, tupleCb) {
      if (!(fields === null || fields === void 0 ? void 0 : fields.length))
        return unitCb();
      if (fields[0].name) {
        return namedCb(fields);
      }
      return tupleCb(fields);
    }
    exports.handleDefinedFields = handleDefinedFields;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/common.js
var require_common3 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/common.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.translateAddress = exports.validateAccounts = exports.toInstruction = exports.parseIdlErrors = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var idl_js_1 = require_idl();
    function parseIdlErrors(idl) {
      const errors = /* @__PURE__ */ new Map();
      if (idl.errors) {
        idl.errors.forEach((e) => {
          var _a;
          let msg = (_a = e.msg) !== null && _a !== void 0 ? _a : e.name;
          errors.set(e.code, msg);
        });
      }
      return errors;
    }
    exports.parseIdlErrors = parseIdlErrors;
    function toInstruction(idlIx, ...args) {
      if (idlIx.args.length != args.length) {
        throw new Error("Invalid argument length");
      }
      const ix = {};
      let idx = 0;
      idlIx.args.forEach((ixArg) => {
        ix[ixArg.name] = args[idx];
        idx += 1;
      });
      return ix;
    }
    exports.toInstruction = toInstruction;
    function validateAccounts(ixAccounts, accounts = {}) {
      ixAccounts.forEach((acc) => {
        if ((0, idl_js_1.isCompositeAccounts)(acc)) {
          validateAccounts(acc.accounts, accounts[acc.name]);
        } else {
          if (!accounts[acc.name]) {
            throw new Error(`Account \`${acc.name}\` not provided.`);
          }
        }
      });
    }
    exports.validateAccounts = validateAccounts;
    function translateAddress(address) {
      return address instanceof web3_js_1.PublicKey ? address : new web3_js_1.PublicKey(address);
    }
    exports.translateAddress = translateAddress;
  }
});

// sdk/node_modules/.pnpm/superstruct@0.15.5/node_modules/superstruct/lib/index.cjs
var require_lib = __commonJS({
  "sdk/node_modules/.pnpm/superstruct@0.15.5/node_modules/superstruct/lib/index.cjs"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var StructError = class extends TypeError {
      constructor(failure, failures) {
        let cached2;
        const {
          message,
          ...rest
        } = failure;
        const {
          path
        } = failure;
        const msg = path.length === 0 ? message : "At path: " + path.join(".") + " -- " + message;
        super(msg);
        this.value = void 0;
        this.key = void 0;
        this.type = void 0;
        this.refinement = void 0;
        this.path = void 0;
        this.branch = void 0;
        this.failures = void 0;
        Object.assign(this, rest);
        this.name = this.constructor.name;
        this.failures = () => {
          var _cached;
          return (_cached = cached2) != null ? _cached : cached2 = [failure, ...failures()];
        };
      }
    };
    function isIterable(x) {
      return isObject(x) && typeof x[Symbol.iterator] === "function";
    }
    function isObject(x) {
      return typeof x === "object" && x != null;
    }
    function isPlainObject(x) {
      if (Object.prototype.toString.call(x) !== "[object Object]") {
        return false;
      }
      const prototype = Object.getPrototypeOf(x);
      return prototype === null || prototype === Object.prototype;
    }
    function print(value) {
      return typeof value === "string" ? JSON.stringify(value) : "" + value;
    }
    function shiftIterator(input) {
      const {
        done,
        value
      } = input.next();
      return done ? void 0 : value;
    }
    function toFailure(result, context, struct2, value) {
      if (result === true) {
        return;
      } else if (result === false) {
        result = {};
      } else if (typeof result === "string") {
        result = {
          message: result
        };
      }
      const {
        path,
        branch
      } = context;
      const {
        type: type2
      } = struct2;
      const {
        refinement,
        message = "Expected a value of type `" + type2 + "`" + (refinement ? " with refinement `" + refinement + "`" : "") + ", but received: `" + print(value) + "`"
      } = result;
      return {
        value,
        type: type2,
        refinement,
        key: path[path.length - 1],
        path,
        branch,
        ...result,
        message
      };
    }
    function* toFailures(result, context, struct2, value) {
      if (!isIterable(result)) {
        result = [result];
      }
      for (const r of result) {
        const failure = toFailure(r, context, struct2, value);
        if (failure) {
          yield failure;
        }
      }
    }
    function* run(value, struct2, options) {
      if (options === void 0) {
        options = {};
      }
      const {
        path = [],
        branch = [value],
        coerce: coerce2 = false,
        mask: mask2 = false
      } = options;
      const ctx = {
        path,
        branch
      };
      if (coerce2) {
        value = struct2.coercer(value, ctx);
        if (mask2 && struct2.type !== "type" && isObject(struct2.schema) && isObject(value) && !Array.isArray(value)) {
          for (const key2 in value) {
            if (struct2.schema[key2] === void 0) {
              delete value[key2];
            }
          }
        }
      }
      let valid = true;
      for (const failure of struct2.validator(value, ctx)) {
        valid = false;
        yield [failure, void 0];
      }
      for (let [k, v, s] of struct2.entries(value, ctx)) {
        const ts = run(v, s, {
          path: k === void 0 ? path : [...path, k],
          branch: k === void 0 ? branch : [...branch, v],
          coerce: coerce2,
          mask: mask2
        });
        for (const t of ts) {
          if (t[0]) {
            valid = false;
            yield [t[0], void 0];
          } else if (coerce2) {
            v = t[1];
            if (k === void 0) {
              value = v;
            } else if (value instanceof Map) {
              value.set(k, v);
            } else if (value instanceof Set) {
              value.add(v);
            } else if (isObject(value)) {
              value[k] = v;
            }
          }
        }
      }
      if (valid) {
        for (const failure of struct2.refiner(value, ctx)) {
          valid = false;
          yield [failure, void 0];
        }
      }
      if (valid) {
        yield [void 0, value];
      }
    }
    var Struct = class {
      constructor(props) {
        this.TYPE = void 0;
        this.type = void 0;
        this.schema = void 0;
        this.coercer = void 0;
        this.validator = void 0;
        this.refiner = void 0;
        this.entries = void 0;
        const {
          type: type2,
          schema,
          validator,
          refiner,
          coercer = (value) => value,
          entries = function* () {
          }
        } = props;
        this.type = type2;
        this.schema = schema;
        this.entries = entries;
        this.coercer = coercer;
        if (validator) {
          this.validator = (value, context) => {
            const result = validator(value, context);
            return toFailures(result, context, this, value);
          };
        } else {
          this.validator = () => [];
        }
        if (refiner) {
          this.refiner = (value, context) => {
            const result = refiner(value, context);
            return toFailures(result, context, this, value);
          };
        } else {
          this.refiner = () => [];
        }
      }
      /**
       * Assert that a value passes the struct's validation, throwing if it doesn't.
       */
      assert(value) {
        return assert(value, this);
      }
      /**
       * Create a value with the struct's coercion logic, then validate it.
       */
      create(value) {
        return create(value, this);
      }
      /**
       * Check if a value passes the struct's validation.
       */
      is(value) {
        return is(value, this);
      }
      /**
       * Mask a value, coercing and validating it, but returning only the subset of
       * properties defined by the struct's schema.
       */
      mask(value) {
        return mask(value, this);
      }
      /**
       * Validate a value with the struct's validation logic, returning a tuple
       * representing the result.
       *
       * You may optionally pass `true` for the `withCoercion` argument to coerce
       * the value before attempting to validate it. If you do, the result will
       * contain the coerced result when successful.
       */
      validate(value, options) {
        if (options === void 0) {
          options = {};
        }
        return validate(value, this, options);
      }
    };
    function assert(value, struct2) {
      const result = validate(value, struct2);
      if (result[0]) {
        throw result[0];
      }
    }
    function create(value, struct2) {
      const result = validate(value, struct2, {
        coerce: true
      });
      if (result[0]) {
        throw result[0];
      } else {
        return result[1];
      }
    }
    function mask(value, struct2) {
      const result = validate(value, struct2, {
        coerce: true,
        mask: true
      });
      if (result[0]) {
        throw result[0];
      } else {
        return result[1];
      }
    }
    function is(value, struct2) {
      const result = validate(value, struct2);
      return !result[0];
    }
    function validate(value, struct2, options) {
      if (options === void 0) {
        options = {};
      }
      const tuples = run(value, struct2, options);
      const tuple2 = shiftIterator(tuples);
      if (tuple2[0]) {
        const error = new StructError(tuple2[0], function* () {
          for (const t of tuples) {
            if (t[0]) {
              yield t[0];
            }
          }
        });
        return [error, void 0];
      } else {
        const v = tuple2[1];
        return [void 0, v];
      }
    }
    function assign() {
      for (var _len = arguments.length, Structs = new Array(_len), _key = 0; _key < _len; _key++) {
        Structs[_key] = arguments[_key];
      }
      const isType = Structs[0].type === "type";
      const schemas = Structs.map((s) => s.schema);
      const schema = Object.assign({}, ...schemas);
      return isType ? type(schema) : object(schema);
    }
    function define(name, validator) {
      return new Struct({
        type: name,
        schema: null,
        validator
      });
    }
    function deprecated(struct2, log) {
      return new Struct({
        ...struct2,
        refiner: (value, ctx) => value === void 0 || struct2.refiner(value, ctx),
        validator(value, ctx) {
          if (value === void 0) {
            return true;
          } else {
            log(value, ctx);
            return struct2.validator(value, ctx);
          }
        }
      });
    }
    function dynamic(fn) {
      return new Struct({
        type: "dynamic",
        schema: null,
        *entries(value, ctx) {
          const struct2 = fn(value, ctx);
          yield* struct2.entries(value, ctx);
        },
        validator(value, ctx) {
          const struct2 = fn(value, ctx);
          return struct2.validator(value, ctx);
        },
        coercer(value, ctx) {
          const struct2 = fn(value, ctx);
          return struct2.coercer(value, ctx);
        },
        refiner(value, ctx) {
          const struct2 = fn(value, ctx);
          return struct2.refiner(value, ctx);
        }
      });
    }
    function lazy(fn) {
      let struct2;
      return new Struct({
        type: "lazy",
        schema: null,
        *entries(value, ctx) {
          var _struct;
          (_struct = struct2) != null ? _struct : struct2 = fn();
          yield* struct2.entries(value, ctx);
        },
        validator(value, ctx) {
          var _struct2;
          (_struct2 = struct2) != null ? _struct2 : struct2 = fn();
          return struct2.validator(value, ctx);
        },
        coercer(value, ctx) {
          var _struct3;
          (_struct3 = struct2) != null ? _struct3 : struct2 = fn();
          return struct2.coercer(value, ctx);
        },
        refiner(value, ctx) {
          var _struct4;
          (_struct4 = struct2) != null ? _struct4 : struct2 = fn();
          return struct2.refiner(value, ctx);
        }
      });
    }
    function omit(struct2, keys) {
      const {
        schema
      } = struct2;
      const subschema = {
        ...schema
      };
      for (const key2 of keys) {
        delete subschema[key2];
      }
      switch (struct2.type) {
        case "type":
          return type(subschema);
        default:
          return object(subschema);
      }
    }
    function partial(struct2) {
      const schema = struct2 instanceof Struct ? {
        ...struct2.schema
      } : {
        ...struct2
      };
      for (const key2 in schema) {
        schema[key2] = optional(schema[key2]);
      }
      return object(schema);
    }
    function pick(struct2, keys) {
      const {
        schema
      } = struct2;
      const subschema = {};
      for (const key2 of keys) {
        subschema[key2] = schema[key2];
      }
      return object(subschema);
    }
    function struct(name, validator) {
      console.warn("superstruct@0.11 - The `struct` helper has been renamed to `define`.");
      return define(name, validator);
    }
    function any() {
      return define("any", () => true);
    }
    function array(Element) {
      return new Struct({
        type: "array",
        schema: Element,
        *entries(value) {
          if (Element && Array.isArray(value)) {
            for (const [i, v] of value.entries()) {
              yield [i, v, Element];
            }
          }
        },
        coercer(value) {
          return Array.isArray(value) ? value.slice() : value;
        },
        validator(value) {
          return Array.isArray(value) || "Expected an array value, but received: " + print(value);
        }
      });
    }
    function bigint() {
      return define("bigint", (value) => {
        return typeof value === "bigint";
      });
    }
    function boolean() {
      return define("boolean", (value) => {
        return typeof value === "boolean";
      });
    }
    function date() {
      return define("date", (value) => {
        return value instanceof Date && !isNaN(value.getTime()) || "Expected a valid `Date` object, but received: " + print(value);
      });
    }
    function enums(values) {
      const schema = {};
      const description = values.map((v) => print(v)).join();
      for (const key2 of values) {
        schema[key2] = key2;
      }
      return new Struct({
        type: "enums",
        schema,
        validator(value) {
          return values.includes(value) || "Expected one of `" + description + "`, but received: " + print(value);
        }
      });
    }
    function func() {
      return define("func", (value) => {
        return typeof value === "function" || "Expected a function, but received: " + print(value);
      });
    }
    function instance(Class) {
      return define("instance", (value) => {
        return value instanceof Class || "Expected a `" + Class.name + "` instance, but received: " + print(value);
      });
    }
    function integer() {
      return define("integer", (value) => {
        return typeof value === "number" && !isNaN(value) && Number.isInteger(value) || "Expected an integer, but received: " + print(value);
      });
    }
    function intersection(Structs) {
      return new Struct({
        type: "intersection",
        schema: null,
        *entries(value, ctx) {
          for (const S of Structs) {
            yield* S.entries(value, ctx);
          }
        },
        *validator(value, ctx) {
          for (const S of Structs) {
            yield* S.validator(value, ctx);
          }
        },
        *refiner(value, ctx) {
          for (const S of Structs) {
            yield* S.refiner(value, ctx);
          }
        }
      });
    }
    function literal(constant) {
      const description = print(constant);
      const t = typeof constant;
      return new Struct({
        type: "literal",
        schema: t === "string" || t === "number" || t === "boolean" ? constant : null,
        validator(value) {
          return value === constant || "Expected the literal `" + description + "`, but received: " + print(value);
        }
      });
    }
    function map(Key, Value) {
      return new Struct({
        type: "map",
        schema: null,
        *entries(value) {
          if (Key && Value && value instanceof Map) {
            for (const [k, v] of value.entries()) {
              yield [k, k, Key];
              yield [k, v, Value];
            }
          }
        },
        coercer(value) {
          return value instanceof Map ? new Map(value) : value;
        },
        validator(value) {
          return value instanceof Map || "Expected a `Map` object, but received: " + print(value);
        }
      });
    }
    function never() {
      return define("never", () => false);
    }
    function nullable(struct2) {
      return new Struct({
        ...struct2,
        validator: (value, ctx) => value === null || struct2.validator(value, ctx),
        refiner: (value, ctx) => value === null || struct2.refiner(value, ctx)
      });
    }
    function number() {
      return define("number", (value) => {
        return typeof value === "number" && !isNaN(value) || "Expected a number, but received: " + print(value);
      });
    }
    function object(schema) {
      const knowns = schema ? Object.keys(schema) : [];
      const Never = never();
      return new Struct({
        type: "object",
        schema: schema ? schema : null,
        *entries(value) {
          if (schema && isObject(value)) {
            const unknowns = new Set(Object.keys(value));
            for (const key2 of knowns) {
              unknowns.delete(key2);
              yield [key2, value[key2], schema[key2]];
            }
            for (const key2 of unknowns) {
              yield [key2, value[key2], Never];
            }
          }
        },
        validator(value) {
          return isObject(value) || "Expected an object, but received: " + print(value);
        },
        coercer(value) {
          return isObject(value) ? {
            ...value
          } : value;
        }
      });
    }
    function optional(struct2) {
      return new Struct({
        ...struct2,
        validator: (value, ctx) => value === void 0 || struct2.validator(value, ctx),
        refiner: (value, ctx) => value === void 0 || struct2.refiner(value, ctx)
      });
    }
    function record(Key, Value) {
      return new Struct({
        type: "record",
        schema: null,
        *entries(value) {
          if (isObject(value)) {
            for (const k in value) {
              const v = value[k];
              yield [k, k, Key];
              yield [k, v, Value];
            }
          }
        },
        validator(value) {
          return isObject(value) || "Expected an object, but received: " + print(value);
        }
      });
    }
    function regexp() {
      return define("regexp", (value) => {
        return value instanceof RegExp;
      });
    }
    function set(Element) {
      return new Struct({
        type: "set",
        schema: null,
        *entries(value) {
          if (Element && value instanceof Set) {
            for (const v of value) {
              yield [v, v, Element];
            }
          }
        },
        coercer(value) {
          return value instanceof Set ? new Set(value) : value;
        },
        validator(value) {
          return value instanceof Set || "Expected a `Set` object, but received: " + print(value);
        }
      });
    }
    function string() {
      return define("string", (value) => {
        return typeof value === "string" || "Expected a string, but received: " + print(value);
      });
    }
    function tuple(Structs) {
      const Never = never();
      return new Struct({
        type: "tuple",
        schema: null,
        *entries(value) {
          if (Array.isArray(value)) {
            const length = Math.max(Structs.length, value.length);
            for (let i = 0; i < length; i++) {
              yield [i, value[i], Structs[i] || Never];
            }
          }
        },
        validator(value) {
          return Array.isArray(value) || "Expected an array, but received: " + print(value);
        }
      });
    }
    function type(schema) {
      const keys = Object.keys(schema);
      return new Struct({
        type: "type",
        schema,
        *entries(value) {
          if (isObject(value)) {
            for (const k of keys) {
              yield [k, value[k], schema[k]];
            }
          }
        },
        validator(value) {
          return isObject(value) || "Expected an object, but received: " + print(value);
        }
      });
    }
    function union(Structs) {
      const description = Structs.map((s) => s.type).join(" | ");
      return new Struct({
        type: "union",
        schema: null,
        coercer(value, ctx) {
          const firstMatch = Structs.find((s) => {
            const [e] = s.validate(value, {
              coerce: true
            });
            return !e;
          }) || unknown();
          return firstMatch.coercer(value, ctx);
        },
        validator(value, ctx) {
          const failures = [];
          for (const S of Structs) {
            const [...tuples] = run(value, S, ctx);
            const [first] = tuples;
            if (!first[0]) {
              return [];
            } else {
              for (const [failure] of tuples) {
                if (failure) {
                  failures.push(failure);
                }
              }
            }
          }
          return ["Expected the value to satisfy a union of `" + description + "`, but received: " + print(value), ...failures];
        }
      });
    }
    function unknown() {
      return define("unknown", () => true);
    }
    function coerce(struct2, condition, coercer) {
      return new Struct({
        ...struct2,
        coercer: (value, ctx) => {
          return is(value, condition) ? struct2.coercer(coercer(value, ctx), ctx) : struct2.coercer(value, ctx);
        }
      });
    }
    function defaulted(struct2, fallback, options) {
      if (options === void 0) {
        options = {};
      }
      return coerce(struct2, unknown(), (x) => {
        const f = typeof fallback === "function" ? fallback() : fallback;
        if (x === void 0) {
          return f;
        }
        if (!options.strict && isPlainObject(x) && isPlainObject(f)) {
          const ret = {
            ...x
          };
          let changed = false;
          for (const key2 in f) {
            if (ret[key2] === void 0) {
              ret[key2] = f[key2];
              changed = true;
            }
          }
          if (changed) {
            return ret;
          }
        }
        return x;
      });
    }
    function trimmed(struct2) {
      return coerce(struct2, string(), (x) => x.trim());
    }
    function empty(struct2) {
      return refine(struct2, "empty", (value) => {
        const size2 = getSize(value);
        return size2 === 0 || "Expected an empty " + struct2.type + " but received one with a size of `" + size2 + "`";
      });
    }
    function getSize(value) {
      if (value instanceof Map || value instanceof Set) {
        return value.size;
      } else {
        return value.length;
      }
    }
    function max(struct2, threshold, options) {
      if (options === void 0) {
        options = {};
      }
      const {
        exclusive
      } = options;
      return refine(struct2, "max", (value) => {
        return exclusive ? value < threshold : value <= threshold || "Expected a " + struct2.type + " less than " + (exclusive ? "" : "or equal to ") + threshold + " but received `" + value + "`";
      });
    }
    function min(struct2, threshold, options) {
      if (options === void 0) {
        options = {};
      }
      const {
        exclusive
      } = options;
      return refine(struct2, "min", (value) => {
        return exclusive ? value > threshold : value >= threshold || "Expected a " + struct2.type + " greater than " + (exclusive ? "" : "or equal to ") + threshold + " but received `" + value + "`";
      });
    }
    function nonempty(struct2) {
      return refine(struct2, "nonempty", (value) => {
        const size2 = getSize(value);
        return size2 > 0 || "Expected a nonempty " + struct2.type + " but received an empty one";
      });
    }
    function pattern(struct2, regexp2) {
      return refine(struct2, "pattern", (value) => {
        return regexp2.test(value) || "Expected a " + struct2.type + " matching `/" + regexp2.source + '/` but received "' + value + '"';
      });
    }
    function size(struct2, min2, max2) {
      if (max2 === void 0) {
        max2 = min2;
      }
      const expected = "Expected a " + struct2.type;
      const of = min2 === max2 ? "of `" + min2 + "`" : "between `" + min2 + "` and `" + max2 + "`";
      return refine(struct2, "size", (value) => {
        if (typeof value === "number" || value instanceof Date) {
          return min2 <= value && value <= max2 || expected + " " + of + " but received `" + value + "`";
        } else if (value instanceof Map || value instanceof Set) {
          const {
            size: size2
          } = value;
          return min2 <= size2 && size2 <= max2 || expected + " with a size " + of + " but received one with a size of `" + size2 + "`";
        } else {
          const {
            length
          } = value;
          return min2 <= length && length <= max2 || expected + " with a length " + of + " but received one with a length of `" + length + "`";
        }
      });
    }
    function refine(struct2, name, refiner) {
      return new Struct({
        ...struct2,
        *refiner(value, ctx) {
          yield* struct2.refiner(value, ctx);
          const result = refiner(value, ctx);
          const failures = toFailures(result, ctx, struct2, value);
          for (const failure of failures) {
            yield {
              ...failure,
              refinement: name
            };
          }
        }
      });
    }
    exports.Struct = Struct;
    exports.StructError = StructError;
    exports.any = any;
    exports.array = array;
    exports.assert = assert;
    exports.assign = assign;
    exports.bigint = bigint;
    exports.boolean = boolean;
    exports.coerce = coerce;
    exports.create = create;
    exports.date = date;
    exports.defaulted = defaulted;
    exports.define = define;
    exports.deprecated = deprecated;
    exports.dynamic = dynamic;
    exports.empty = empty;
    exports.enums = enums;
    exports.func = func;
    exports.instance = instance;
    exports.integer = integer;
    exports.intersection = intersection;
    exports.is = is;
    exports.lazy = lazy;
    exports.literal = literal;
    exports.map = map;
    exports.mask = mask;
    exports.max = max;
    exports.min = min;
    exports.never = never;
    exports.nonempty = nonempty;
    exports.nullable = nullable;
    exports.number = number;
    exports.object = object;
    exports.omit = omit;
    exports.optional = optional;
    exports.partial = partial;
    exports.pattern = pattern;
    exports.pick = pick;
    exports.record = record;
    exports.refine = refine;
    exports.regexp = regexp;
    exports.set = set;
    exports.size = size;
    exports.string = string;
    exports.struct = struct;
    exports.trimmed = trimmed;
    exports.tuple = tuple;
    exports.type = type;
    exports.union = union;
    exports.unknown = unknown;
    exports.validate = validate;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/rpc.js
var require_rpc = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/rpc.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.simulateTransaction = exports.getMultipleAccountsAndContext = exports.getMultipleAccounts = exports.invoke = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var common_js_1 = require_common();
    var common_js_2 = require_common3();
    var provider_js_1 = require_provider();
    var superstruct_1 = require_lib();
    async function invoke(programId, accounts, data, provider) {
      programId = (0, common_js_2.translateAddress)(programId);
      if (!provider) {
        provider = (0, provider_js_1.getProvider)();
      }
      const tx = new web3_js_1.Transaction();
      tx.add(new web3_js_1.TransactionInstruction({
        programId,
        keys: accounts !== null && accounts !== void 0 ? accounts : [],
        data
      }));
      if (provider.sendAndConfirm === void 0) {
        throw new Error("This function requires 'Provider.sendAndConfirm' to be implemented.");
      }
      return await provider.sendAndConfirm(tx, []);
    }
    exports.invoke = invoke;
    var GET_MULTIPLE_ACCOUNTS_LIMIT = 99;
    async function getMultipleAccounts(connection, publicKeys, commitment) {
      const results = await getMultipleAccountsAndContext(connection, publicKeys, commitment);
      return results.map((result) => {
        return result ? { publicKey: result.publicKey, account: result.account } : null;
      });
    }
    exports.getMultipleAccounts = getMultipleAccounts;
    async function getMultipleAccountsAndContext(connection, publicKeys, commitment) {
      if (publicKeys.length <= GET_MULTIPLE_ACCOUNTS_LIMIT) {
        return await getMultipleAccountsAndContextCore(connection, publicKeys, commitment);
      } else {
        const batches = (0, common_js_1.chunks)(publicKeys, GET_MULTIPLE_ACCOUNTS_LIMIT);
        const results = await Promise.all(batches.map((batch) => getMultipleAccountsAndContextCore(connection, batch, commitment)));
        return results.flat();
      }
    }
    exports.getMultipleAccountsAndContext = getMultipleAccountsAndContext;
    async function getMultipleAccountsAndContextCore(connection, publicKeys, commitmentOverride) {
      const commitment = commitmentOverride !== null && commitmentOverride !== void 0 ? commitmentOverride : connection.commitment;
      const { value: accountInfos, context } = await connection.getMultipleAccountsInfoAndContext(publicKeys, commitment);
      const accounts = accountInfos.map((account, idx) => {
        if (account === null) {
          return null;
        }
        return {
          publicKey: publicKeys[idx],
          account,
          context
        };
      });
      return accounts;
    }
    async function simulateTransaction(connection, transaction, signers, commitment, includeAccounts) {
      var _a;
      if (signers && signers.length > 0) {
        transaction.sign(...signers);
      }
      const message = transaction._compile();
      const signData = message.serialize();
      const wireTransaction = transaction._serialize(signData);
      const encodedTransaction = wireTransaction.toString("base64");
      const config = {
        encoding: "base64",
        commitment: commitment !== null && commitment !== void 0 ? commitment : connection.commitment
      };
      if (includeAccounts) {
        const addresses = (Array.isArray(includeAccounts) ? includeAccounts : message.nonProgramIds()).map((key2) => key2.toBase58());
        config["accounts"] = {
          encoding: "base64",
          addresses
        };
      }
      if (signers && signers.length > 0) {
        config.sigVerify = true;
      }
      const args = [encodedTransaction, config];
      const unsafeRes = await connection._rpcRequest("simulateTransaction", args);
      const res = (0, superstruct_1.create)(unsafeRes, SimulatedTransactionResponseStruct);
      if ("error" in res) {
        let logs;
        if ("data" in res.error) {
          logs = (_a = res.error.data) === null || _a === void 0 ? void 0 : _a.logs;
          if (logs && Array.isArray(logs)) {
            const traceIndent = "\n    ";
            const logTrace = traceIndent + logs.join(traceIndent);
            console.error(res.error.message, logTrace);
          }
        }
        throw new web3_js_1.SendTransactionError("failed to simulate transaction: " + res.error.message, logs);
      }
      return res.result;
    }
    exports.simulateTransaction = simulateTransaction;
    function jsonRpcResult(schema) {
      return (0, superstruct_1.coerce)(createRpcResult(schema), UnknownRpcResult, (value) => {
        if ("error" in value) {
          return value;
        } else {
          return {
            ...value,
            result: (0, superstruct_1.create)(value.result, schema)
          };
        }
      });
    }
    var UnknownRpcResult = createRpcResult((0, superstruct_1.unknown)());
    function createRpcResult(result) {
      return (0, superstruct_1.union)([
        (0, superstruct_1.type)({
          jsonrpc: (0, superstruct_1.literal)("2.0"),
          id: (0, superstruct_1.string)(),
          result
        }),
        (0, superstruct_1.type)({
          jsonrpc: (0, superstruct_1.literal)("2.0"),
          id: (0, superstruct_1.string)(),
          error: (0, superstruct_1.type)({
            code: (0, superstruct_1.unknown)(),
            message: (0, superstruct_1.string)(),
            data: (0, superstruct_1.optional)((0, superstruct_1.any)())
          })
        })
      ]);
    }
    function jsonRpcResultAndContext(value) {
      return jsonRpcResult((0, superstruct_1.type)({
        context: (0, superstruct_1.type)({
          slot: (0, superstruct_1.number)()
        }),
        value
      }));
    }
    var SimulatedTransactionResponseStruct = jsonRpcResultAndContext((0, superstruct_1.type)({
      err: (0, superstruct_1.nullable)((0, superstruct_1.union)([(0, superstruct_1.type)({}), (0, superstruct_1.string)()])),
      logs: (0, superstruct_1.nullable)((0, superstruct_1.array)((0, superstruct_1.string)())),
      accounts: (0, superstruct_1.optional)((0, superstruct_1.nullable)((0, superstruct_1.array)((0, superstruct_1.nullable)((0, superstruct_1.type)({
        executable: (0, superstruct_1.boolean)(),
        owner: (0, superstruct_1.string)(),
        lamports: (0, superstruct_1.number)(),
        data: (0, superstruct_1.array)((0, superstruct_1.string)()),
        rentEpoch: (0, superstruct_1.optional)((0, superstruct_1.number)())
      }))))),
      unitsConsumed: (0, superstruct_1.optional)((0, superstruct_1.number)())
    }));
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/provider.js
var require_provider = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/provider.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.getProvider = exports.setProvider = exports.AnchorProvider = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var index_js_1 = require_bytes();
    var common_js_1 = require_common();
    var rpc_js_1 = require_rpc();
    var AnchorProvider = class _AnchorProvider {
      /**
       * @param connection The cluster connection where the program is deployed.
       * @param wallet     The wallet used to pay for and sign all transactions.
       * @param opts       Transaction confirmation options to use by default.
       */
      constructor(connection, wallet, opts = _AnchorProvider.defaultOptions()) {
        this.connection = connection;
        this.wallet = wallet;
        this.opts = opts;
        this.publicKey = wallet === null || wallet === void 0 ? void 0 : wallet.publicKey;
      }
      static defaultOptions() {
        return {
          preflightCommitment: "processed",
          commitment: "processed"
        };
      }
      /**
       * Returns a `Provider` with a wallet read from the local filesystem.
       *
       * @param url  The network cluster url.
       * @param opts The default transaction confirmation options.
       *
       * (This api is for Node only.)
       */
      static local(url, opts = _AnchorProvider.defaultOptions()) {
        if (common_js_1.isBrowser) {
          throw new Error(`Provider local is not available on browser.`);
        }
        const connection = new web3_js_1.Connection(url !== null && url !== void 0 ? url : "http://127.0.0.1:8899", opts.preflightCommitment);
        const NodeWallet = require_nodewallet().default;
        const wallet = NodeWallet.local();
        return new _AnchorProvider(connection, wallet, opts);
      }
      /**
       * Returns a `Provider` read from the `ANCHOR_PROVIDER_URL` environment
       * variable
       *
       * (This api is for Node only.)
       */
      static env() {
        if (common_js_1.isBrowser) {
          throw new Error(`Provider env is not available on browser.`);
        }
        const process2 = __require("process");
        const url = process2.env.ANCHOR_PROVIDER_URL;
        if (url === void 0) {
          throw new Error("ANCHOR_PROVIDER_URL is not defined");
        }
        const options = _AnchorProvider.defaultOptions();
        const connection = new web3_js_1.Connection(url, options.commitment);
        const NodeWallet = require_nodewallet().default;
        const wallet = NodeWallet.local();
        return new _AnchorProvider(connection, wallet, options);
      }
      /**
       * Sends the given transaction, paid for and signed by the provider's wallet.
       *
       * @param tx      The transaction to send.
       * @param signers The signers of the transaction.
       * @param opts    Transaction confirmation options.
       */
      async sendAndConfirm(tx, signers, opts) {
        var _a, _b, _c, _d;
        if (opts === void 0) {
          opts = this.opts;
        }
        if ((0, common_js_1.isVersionedTransaction)(tx)) {
          if (signers) {
            tx.sign(signers);
          }
        } else {
          tx.feePayer = (_a = tx.feePayer) !== null && _a !== void 0 ? _a : this.wallet.publicKey;
          if (!tx.recentBlockhash || tx.recentBlockhash === "11111111111111111111111111111111") {
            tx.recentBlockhash = (await this.connection.getLatestBlockhash(opts.preflightCommitment)).blockhash;
          }
          if (signers) {
            for (const signer of signers) {
              tx.partialSign(signer);
            }
          }
        }
        tx = await this.wallet.signTransaction(tx);
        const rawTx = tx.serialize();
        try {
          return await sendAndConfirmRawTransaction(this.connection, rawTx, opts);
        } catch (err) {
          if (err instanceof ConfirmError) {
            const txSig = index_js_1.bs58.encode((0, common_js_1.isVersionedTransaction)(tx) ? ((_b = tx.signatures) === null || _b === void 0 ? void 0 : _b[0]) || new Uint8Array() : (_c = tx.signature) !== null && _c !== void 0 ? _c : new Uint8Array());
            const maxVer = (0, common_js_1.isVersionedTransaction)(tx) ? 0 : void 0;
            const failedTx = await this.connection.getTransaction(txSig, {
              commitment: "confirmed",
              maxSupportedTransactionVersion: maxVer
            });
            if (!failedTx) {
              throw err;
            } else {
              const logs = (_d = failedTx.meta) === null || _d === void 0 ? void 0 : _d.logMessages;
              throw !logs ? err : new web3_js_1.SendTransactionError(err.message, logs);
            }
          } else {
            throw err;
          }
        }
      }
      /**
       * Similar to `send`, but for an array of transactions and signers.
       * All transactions need to be of the same type, it doesn't support a mix of `VersionedTransaction`s and `Transaction`s.
       *
       * @param txWithSigners Array of transactions and signers.
       * @param opts          Transaction confirmation options.
       */
      async sendAll(txWithSigners, opts) {
        var _a, _b, _c;
        if (opts === void 0) {
          opts = this.opts;
        }
        let blockhashPromise;
        const ensureBlockhash = () => {
          if (!blockhashPromise) {
            blockhashPromise = this.connection.getLatestBlockhash(opts.preflightCommitment).then((b) => b.blockhash);
          }
          return blockhashPromise;
        };
        let txs = await Promise.all(txWithSigners.map(async (r) => {
          var _a2, _b2;
          if ((0, common_js_1.isVersionedTransaction)(r.tx)) {
            let tx = r.tx;
            if (r.signers) {
              tx.sign(r.signers);
            }
            return tx;
          } else {
            let tx = r.tx;
            let signers = (_a2 = r.signers) !== null && _a2 !== void 0 ? _a2 : [];
            tx.feePayer = (_b2 = tx.feePayer) !== null && _b2 !== void 0 ? _b2 : this.wallet.publicKey;
            if (!tx.recentBlockhash || tx.recentBlockhash === "11111111111111111111111111111111") {
              tx.recentBlockhash = await ensureBlockhash();
            }
            signers.forEach((kp) => {
              tx.partialSign(kp);
            });
            return tx;
          }
        }));
        const signedTxs = await this.wallet.signAllTransactions(txs);
        const sigs = [];
        for (let k = 0; k < txs.length; k += 1) {
          const tx = signedTxs[k];
          const rawTx = tx.serialize();
          try {
            sigs.push(await sendAndConfirmRawTransaction(this.connection, rawTx, opts));
          } catch (err) {
            if (err instanceof ConfirmError) {
              const txSig = index_js_1.bs58.encode((0, common_js_1.isVersionedTransaction)(tx) ? ((_a = tx.signatures) === null || _a === void 0 ? void 0 : _a[0]) || new Uint8Array() : (_b = tx.signature) !== null && _b !== void 0 ? _b : new Uint8Array());
              const maxVer = (0, common_js_1.isVersionedTransaction)(tx) ? 0 : void 0;
              const failedTx = await this.connection.getTransaction(txSig, {
                commitment: "confirmed",
                maxSupportedTransactionVersion: maxVer
              });
              if (!failedTx) {
                throw err;
              } else {
                const logs = (_c = failedTx.meta) === null || _c === void 0 ? void 0 : _c.logMessages;
                throw !logs ? err : new web3_js_1.SendTransactionError(err.message, logs);
              }
            } else {
              throw err;
            }
          }
        }
        return sigs;
      }
      /**
       * Simulates the given transaction, returning emitted logs from execution.
       *
       * @param tx      The transaction to send.
       * @param signers The signers of the transaction. If unset, the transaction
       *                will be simulated with the "sigVerify: false" option. This
       *                allows for simulation of transactions without asking the
       *                wallet for a signature.
       * @param opts    Transaction confirmation options.
       */
      async simulate(tx, signers, commitment, includeAccounts) {
        let result;
        if ((0, common_js_1.isVersionedTransaction)(tx)) {
          if (signers && signers.length > 0) {
            tx.sign(signers);
            tx = await this.wallet.signTransaction(tx);
          }
          result = await this.connection.simulateTransaction(tx, { commitment });
        } else {
          tx.feePayer = tx.feePayer || this.wallet.publicKey;
          if (!tx.recentBlockhash || tx.recentBlockhash === "11111111111111111111111111111111") {
            tx.recentBlockhash = (await this.connection.getLatestBlockhash(commitment !== null && commitment !== void 0 ? commitment : this.connection.commitment)).blockhash;
          }
          if (signers && signers.length > 0) {
            tx = await this.wallet.signTransaction(tx);
          }
          result = await (0, rpc_js_1.simulateTransaction)(this.connection, tx, signers, commitment, includeAccounts);
        }
        if (result.value.err) {
          throw new SimulateError(result.value);
        }
        return result.value;
      }
    };
    exports.AnchorProvider = AnchorProvider;
    var SimulateError = class extends Error {
      constructor(simulationResponse, message) {
        super(message);
        this.simulationResponse = simulationResponse;
      }
    };
    async function sendAndConfirmRawTransaction(connection, rawTransaction, options) {
      const sendOptions = options ? {
        skipPreflight: options.skipPreflight,
        preflightCommitment: options.preflightCommitment || options.commitment,
        maxRetries: options.maxRetries,
        minContextSlot: options.minContextSlot
      } : {};
      let status;
      const startTime = Date.now();
      while (Date.now() - startTime < 6e4) {
        try {
          const signature = await connection.sendRawTransaction(rawTransaction, sendOptions);
          if (options === null || options === void 0 ? void 0 : options.blockhash) {
            if (sendOptions.maxRetries === 0) {
              const abortSignal = AbortSignal.timeout(15e3);
              status = (await connection.confirmTransaction({ abortSignal, signature, ...options.blockhash }, options && options.commitment)).value;
            } else {
              status = (await connection.confirmTransaction({ signature, ...options.blockhash }, options && options.commitment)).value;
            }
          } else {
            status = (await connection.confirmTransaction(signature, options && options.commitment)).value;
          }
          if (status.err) {
            throw new ConfirmError(`Raw transaction ${signature} failed (${JSON.stringify(status)})`);
          }
          return signature;
        } catch (err) {
          if (err.name === "TimeoutError") {
            continue;
          }
          throw err;
        }
      }
      throw Error("Transaction failed to confirm in 60s");
    }
    var ConfirmError = class extends Error {
      constructor(message) {
        super(message);
      }
    };
    function setProvider(provider) {
      _provider = provider;
    }
    exports.setProvider = setProvider;
    function getProvider() {
      if (_provider === null) {
        return AnchorProvider.local();
      }
      return _provider;
    }
    exports.getProvider = getProvider;
    var _provider = null;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+errors@1.2.1/node_modules/@anchor-lang/errors/dist/index.js
var require_dist = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+errors@1.2.1/node_modules/@anchor-lang/errors/dist/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ANCHOR_ERROR__REQUIRE_EQ_VIOLATED = exports.ANCHOR_ERROR__REQUIRE_VIOLATED = exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_PROGRAM_ID = exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION_DELEGATE = exports.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_METADATA_ADDRESS = exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_MEMBER_ADDRESS = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_GROUP_ADDRESS = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION = exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM = exports.ANCHOR_ERROR__CONSTRAINT_MINT_TOKEN_PROGRAM = exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_TOKEN_PROGRAM = exports.ANCHOR_ERROR__CONSTRAINT_ACCOUNT_IS_NONE = exports.ANCHOR_ERROR__CONSTRAINT_SPACE = exports.ANCHOR_ERROR__CONSTRAINT_MINT_DECIMALS = exports.ANCHOR_ERROR__CONSTRAINT_MINT_FREEZE_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_MINT_MINT_AUTHORITY = exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_OWNER = exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_MINT = exports.ANCHOR_ERROR__CONSTRAINT_ZERO = exports.ANCHOR_ERROR__CONSTRAINT_ADDRESS = exports.ANCHOR_ERROR__CONSTRAINT_CLOSE = exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_INIT = exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED = exports.ANCHOR_ERROR__CONSTRAINT_STATE = exports.ANCHOR_ERROR__CONSTRAINT_EXECUTABLE = exports.ANCHOR_ERROR__CONSTRAINT_SEEDS = exports.ANCHOR_ERROR__CONSTRAINT_RENT_EXEMPT = exports.ANCHOR_ERROR__CONSTRAINT_OWNER = exports.ANCHOR_ERROR__CONSTRAINT_RAW = exports.ANCHOR_ERROR__CONSTRAINT_SIGNER = exports.ANCHOR_ERROR__CONSTRAINT_HAS_ONE = exports.ANCHOR_ERROR__CONSTRAINT_MUT = exports.ANCHOR_ERROR__EVENT_INSTRUCTION_STUB = exports.ANCHOR_ERROR__IDL_ACCOUNT_NOT_EMPTY = exports.ANCHOR_ERROR__IDL_INSTRUCTION_INVALID_PROGRAM = exports.ANCHOR_ERROR__IDL_INSTRUCTION_STUB = exports.ANCHOR_ERROR__INSTRUCTION_DID_NOT_SERIALIZE = exports.ANCHOR_ERROR__INSTRUCTION_DID_NOT_DESERIALIZE = exports.ANCHOR_ERROR__INSTRUCTION_FALLBACK_NOT_FOUND = exports.ANCHOR_ERROR__INSTRUCTION_MISSING = void 0;
    exports.ANCHOR_ERROR__DEPRECATED = exports.ANCHOR_ERROR__INVALID_NUMERIC_CONVERSION = exports.ANCHOR_ERROR__TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT = exports.ANCHOR_ERROR__DECLARED_PROGRAM_ID_MISMATCH = exports.ANCHOR_ERROR__ACCOUNT_DUPLICATE_REALLOCS = exports.ANCHOR_ERROR__ACCOUNT_REALLOC_EXCEEDS_LIMIT = exports.ANCHOR_ERROR__ACCOUNT_SYSVAR_MISMATCH = exports.ANCHOR_ERROR__ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT = exports.ANCHOR_ERROR__ACCOUNT_NOT_PROGRAM_DATA = exports.ANCHOR_ERROR__ACCOUNT_NOT_INITIALIZED = exports.ANCHOR_ERROR__ACCOUNT_NOT_SYSTEM_OWNED = exports.ANCHOR_ERROR__ACCOUNT_NOT_SIGNER = exports.ANCHOR_ERROR__INVALID_PROGRAM_EXECUTABLE = exports.ANCHOR_ERROR__INVALID_PROGRAM_ID = exports.ANCHOR_ERROR__ACCOUNT_OWNED_BY_WRONG_PROGRAM = exports.ANCHOR_ERROR__ACCOUNT_NOT_MUTABLE = exports.ANCHOR_ERROR__ACCOUNT_NOT_ENOUGH_KEYS = exports.ANCHOR_ERROR__ACCOUNT_DID_NOT_SERIALIZE = exports.ANCHOR_ERROR__ACCOUNT_DID_NOT_DESERIALIZE = exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_MISMATCH = exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_NOT_FOUND = exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_ALREADY_SET = exports.ANCHOR_ERROR__REQUIRE_GTE_VIOLATED = exports.ANCHOR_ERROR__REQUIRE_GT_VIOLATED = exports.ANCHOR_ERROR__REQUIRE_KEYS_NEQ_VIOLATED = exports.ANCHOR_ERROR__REQUIRE_NEQ_VIOLATED = exports.ANCHOR_ERROR__REQUIRE_KEYS_EQ_VIOLATED = void 0;
    exports.ANCHOR_ERROR__INSTRUCTION_MISSING = 100;
    exports.ANCHOR_ERROR__INSTRUCTION_FALLBACK_NOT_FOUND = 101;
    exports.ANCHOR_ERROR__INSTRUCTION_DID_NOT_DESERIALIZE = 102;
    exports.ANCHOR_ERROR__INSTRUCTION_DID_NOT_SERIALIZE = 103;
    exports.ANCHOR_ERROR__IDL_INSTRUCTION_STUB = 1e3;
    exports.ANCHOR_ERROR__IDL_INSTRUCTION_INVALID_PROGRAM = 1001;
    exports.ANCHOR_ERROR__IDL_ACCOUNT_NOT_EMPTY = 1002;
    exports.ANCHOR_ERROR__EVENT_INSTRUCTION_STUB = 1500;
    exports.ANCHOR_ERROR__CONSTRAINT_MUT = 2e3;
    exports.ANCHOR_ERROR__CONSTRAINT_HAS_ONE = 2001;
    exports.ANCHOR_ERROR__CONSTRAINT_SIGNER = 2002;
    exports.ANCHOR_ERROR__CONSTRAINT_RAW = 2003;
    exports.ANCHOR_ERROR__CONSTRAINT_OWNER = 2004;
    exports.ANCHOR_ERROR__CONSTRAINT_RENT_EXEMPT = 2005;
    exports.ANCHOR_ERROR__CONSTRAINT_SEEDS = 2006;
    exports.ANCHOR_ERROR__CONSTRAINT_EXECUTABLE = 2007;
    exports.ANCHOR_ERROR__CONSTRAINT_STATE = 2008;
    exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED = 2009;
    exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_INIT = 2010;
    exports.ANCHOR_ERROR__CONSTRAINT_CLOSE = 2011;
    exports.ANCHOR_ERROR__CONSTRAINT_ADDRESS = 2012;
    exports.ANCHOR_ERROR__CONSTRAINT_ZERO = 2013;
    exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_MINT = 2014;
    exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_OWNER = 2015;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_MINT_AUTHORITY = 2016;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_FREEZE_AUTHORITY = 2017;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_DECIMALS = 2018;
    exports.ANCHOR_ERROR__CONSTRAINT_SPACE = 2019;
    exports.ANCHOR_ERROR__CONSTRAINT_ACCOUNT_IS_NONE = 2020;
    exports.ANCHOR_ERROR__CONSTRAINT_TOKEN_TOKEN_PROGRAM = 2021;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_TOKEN_PROGRAM = 2022;
    exports.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM = 2023;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION = 2024;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_AUTHORITY = 2025;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_GROUP_ADDRESS = 2026;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION = 2027;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_AUTHORITY = 2028;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_MEMBER_ADDRESS = 2029;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION = 2030;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_AUTHORITY = 2031;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_METADATA_ADDRESS = 2032;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION = 2033;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION_AUTHORITY = 2034;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION = 2035;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION_DELEGATE = 2036;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION = 2037;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_AUTHORITY = 2038;
    exports.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_PROGRAM_ID = 2039;
    exports.ANCHOR_ERROR__REQUIRE_VIOLATED = 2500;
    exports.ANCHOR_ERROR__REQUIRE_EQ_VIOLATED = 2501;
    exports.ANCHOR_ERROR__REQUIRE_KEYS_EQ_VIOLATED = 2502;
    exports.ANCHOR_ERROR__REQUIRE_NEQ_VIOLATED = 2503;
    exports.ANCHOR_ERROR__REQUIRE_KEYS_NEQ_VIOLATED = 2504;
    exports.ANCHOR_ERROR__REQUIRE_GT_VIOLATED = 2505;
    exports.ANCHOR_ERROR__REQUIRE_GTE_VIOLATED = 2506;
    exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_ALREADY_SET = 3e3;
    exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_NOT_FOUND = 3001;
    exports.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_MISMATCH = 3002;
    exports.ANCHOR_ERROR__ACCOUNT_DID_NOT_DESERIALIZE = 3003;
    exports.ANCHOR_ERROR__ACCOUNT_DID_NOT_SERIALIZE = 3004;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_ENOUGH_KEYS = 3005;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_MUTABLE = 3006;
    exports.ANCHOR_ERROR__ACCOUNT_OWNED_BY_WRONG_PROGRAM = 3007;
    exports.ANCHOR_ERROR__INVALID_PROGRAM_ID = 3008;
    exports.ANCHOR_ERROR__INVALID_PROGRAM_EXECUTABLE = 3009;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_SIGNER = 3010;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_SYSTEM_OWNED = 3011;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_INITIALIZED = 3012;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_PROGRAM_DATA = 3013;
    exports.ANCHOR_ERROR__ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT = 3014;
    exports.ANCHOR_ERROR__ACCOUNT_SYSVAR_MISMATCH = 3015;
    exports.ANCHOR_ERROR__ACCOUNT_REALLOC_EXCEEDS_LIMIT = 3016;
    exports.ANCHOR_ERROR__ACCOUNT_DUPLICATE_REALLOCS = 3017;
    exports.ANCHOR_ERROR__DECLARED_PROGRAM_ID_MISMATCH = 4100;
    exports.ANCHOR_ERROR__TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT = 4101;
    exports.ANCHOR_ERROR__INVALID_NUMERIC_CONVERSION = 4102;
    exports.ANCHOR_ERROR__DEPRECATED = 5e3;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/features.js
var require_features = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/features.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.isSet = exports.set = void 0;
    var _AVAILABLE_FEATURES = /* @__PURE__ */ new Set(["debug-logs"]);
    var _FEATURES = /* @__PURE__ */ new Map();
    function set(key2) {
      if (!_AVAILABLE_FEATURES.has(key2)) {
        throw new Error("Invalid feature");
      }
      _FEATURES.set(key2, true);
    }
    exports.set = set;
    function isSet(key2) {
      return _FEATURES.get(key2) !== void 0;
    }
    exports.isSet = isSet;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/error.js
var require_error = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/error.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.LangErrorMessage = exports.LangErrorCode = exports.translateError = exports.ProgramError = exports.AnchorError = exports.ProgramErrorStack = exports.IdlError = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var errors = __importStar(require_dist());
    var features = __importStar(require_features());
    var IdlError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "IdlError";
      }
    };
    exports.IdlError = IdlError;
    var ProgramErrorStack = class _ProgramErrorStack {
      constructor(stack) {
        this.stack = stack;
      }
      static parse(logs) {
        var _a;
        const programKeyRegex = /^Program (\w*) invoke/;
        const successRegex = /^Program \w* success/;
        const programStack = [];
        for (let i = 0; i < logs.length; i++) {
          if (successRegex.exec(logs[i])) {
            programStack.pop();
            continue;
          }
          const programKey = (_a = programKeyRegex.exec(logs[i])) === null || _a === void 0 ? void 0 : _a[1];
          if (!programKey) {
            continue;
          }
          programStack.push(new web3_js_1.PublicKey(programKey));
        }
        return new _ProgramErrorStack(programStack);
      }
    };
    exports.ProgramErrorStack = ProgramErrorStack;
    var AnchorError = class _AnchorError extends Error {
      constructor(errorCode, errorMessage, errorLogs, logs, origin, comparedValues) {
        super(errorLogs.join("\n").replace("Program log: ", ""));
        this.errorLogs = errorLogs;
        this.logs = logs;
        this.error = { errorCode, errorMessage, comparedValues, origin };
        this._programErrorStack = ProgramErrorStack.parse(logs);
      }
      static parse(logs) {
        if (!logs) {
          return null;
        }
        const anchorErrorLogIndex = logs.findIndex((log) => log.startsWith("Program log: AnchorError"));
        if (anchorErrorLogIndex === -1) {
          return null;
        }
        const anchorErrorLog = logs[anchorErrorLogIndex];
        const errorLogs = [anchorErrorLog];
        let comparedValues;
        if (anchorErrorLogIndex + 1 < logs.length) {
          if (logs[anchorErrorLogIndex + 1] === "Program log: Left:") {
            const pubkeyRegex = /^Program log: (.*)$/;
            const leftPubkey = pubkeyRegex.exec(logs[anchorErrorLogIndex + 2])[1];
            const rightPubkey = pubkeyRegex.exec(logs[anchorErrorLogIndex + 4])[1];
            comparedValues = [
              new web3_js_1.PublicKey(leftPubkey),
              new web3_js_1.PublicKey(rightPubkey)
            ];
            errorLogs.push(...logs.slice(anchorErrorLogIndex + 1, anchorErrorLogIndex + 5));
          } else if (logs[anchorErrorLogIndex + 1].startsWith("Program log: Left:")) {
            const valueRegex = /^Program log: (Left|Right): (.*)$/;
            const leftValue = valueRegex.exec(logs[anchorErrorLogIndex + 1])[2];
            const rightValue = valueRegex.exec(logs[anchorErrorLogIndex + 2])[2];
            errorLogs.push(...logs.slice(anchorErrorLogIndex + 1, anchorErrorLogIndex + 3));
            comparedValues = [leftValue, rightValue];
          }
        }
        const regexNoInfo = /^Program log: AnchorError occurred\. Error Code: (.*)\. Error Number: (\d*)\. Error Message: (.*)\./;
        const noInfoAnchorErrorLog = regexNoInfo.exec(anchorErrorLog);
        const regexFileLine = /^Program log: AnchorError thrown in (.*):(\d*)\. Error Code: (.*)\. Error Number: (\d*)\. Error Message: (.*)\./;
        const fileLineAnchorErrorLog = regexFileLine.exec(anchorErrorLog);
        const regexAccountName = /^Program log: AnchorError caused by account: (.*)\. Error Code: (.*)\. Error Number: (\d*)\. Error Message: (.*)\./;
        const accountNameAnchorErrorLog = regexAccountName.exec(anchorErrorLog);
        if (noInfoAnchorErrorLog) {
          const [errorCodeString, errorNumber, errorMessage] = noInfoAnchorErrorLog.slice(1, 4);
          const errorCode = {
            code: errorCodeString,
            number: parseInt(errorNumber)
          };
          return new _AnchorError(errorCode, errorMessage, errorLogs, logs, void 0, comparedValues);
        } else if (fileLineAnchorErrorLog) {
          const [file, line, errorCodeString, errorNumber, errorMessage] = fileLineAnchorErrorLog.slice(1, 6);
          const errorCode = {
            code: errorCodeString,
            number: parseInt(errorNumber)
          };
          const fileLine = { file, line: parseInt(line) };
          return new _AnchorError(errorCode, errorMessage, errorLogs, logs, fileLine, comparedValues);
        } else if (accountNameAnchorErrorLog) {
          const [accountName, errorCodeString, errorNumber, errorMessage] = accountNameAnchorErrorLog.slice(1, 5);
          const origin = accountName;
          const errorCode = {
            code: errorCodeString,
            number: parseInt(errorNumber)
          };
          return new _AnchorError(errorCode, errorMessage, errorLogs, logs, origin, comparedValues);
        } else {
          return null;
        }
      }
      get program() {
        return this._programErrorStack.stack[this._programErrorStack.stack.length - 1];
      }
      get programErrorStack() {
        return this._programErrorStack.stack;
      }
      toString() {
        return this.message;
      }
    };
    exports.AnchorError = AnchorError;
    var ProgramError = class _ProgramError extends Error {
      constructor(code, msg, logs) {
        super();
        this.code = code;
        this.msg = msg;
        this.logs = logs;
        if (logs) {
          this._programErrorStack = ProgramErrorStack.parse(logs);
        }
      }
      static parse(err, idlErrors) {
        const errString = err.toString();
        let unparsedErrorCode;
        if (errString.includes("custom program error:")) {
          let components = errString.split("custom program error: ");
          if (components.length !== 2) {
            return null;
          } else {
            unparsedErrorCode = components[1];
          }
        } else {
          const matches = errString.match(/"Custom":([0-9]+)}/g);
          if (!matches || matches.length > 1) {
            return null;
          }
          unparsedErrorCode = matches[0].match(/([0-9]+)/g)[0];
        }
        let errorCode;
        try {
          errorCode = parseInt(unparsedErrorCode);
        } catch (parseErr) {
          return null;
        }
        let errorMsg = idlErrors.get(errorCode);
        if (errorMsg !== void 0) {
          return new _ProgramError(errorCode, errorMsg, err.logs);
        }
        errorMsg = exports.LangErrorMessage.get(errorCode);
        if (errorMsg !== void 0) {
          return new _ProgramError(errorCode, errorMsg, err.logs);
        }
        return null;
      }
      get program() {
        var _a;
        return (_a = this._programErrorStack) === null || _a === void 0 ? void 0 : _a.stack[this._programErrorStack.stack.length - 1];
      }
      get programErrorStack() {
        var _a;
        return (_a = this._programErrorStack) === null || _a === void 0 ? void 0 : _a.stack;
      }
      toString() {
        return this.msg;
      }
    };
    exports.ProgramError = ProgramError;
    function translateError(err, idlErrors) {
      if (features.isSet("debug-logs")) {
        console.log("Translating error:", err);
      }
      const anchorError = AnchorError.parse(err.logs);
      if (anchorError) {
        return anchorError;
      }
      const programError = ProgramError.parse(err, idlErrors);
      if (programError) {
        return programError;
      }
      if (err.logs) {
        const handler = {
          get: function(target, prop) {
            if (prop === "programErrorStack") {
              return target.programErrorStack.stack;
            } else if (prop === "program") {
              return target.programErrorStack.stack[err.programErrorStack.stack.length - 1];
            } else {
              return Reflect.get(...arguments);
            }
          }
        };
        err.programErrorStack = ProgramErrorStack.parse(err.logs);
        return new Proxy(err, handler);
      }
      return err;
    }
    exports.translateError = translateError;
    exports.LangErrorCode = {
      // Instructions.
      InstructionMissing: errors.ANCHOR_ERROR__INSTRUCTION_MISSING,
      InstructionFallbackNotFound: errors.ANCHOR_ERROR__INSTRUCTION_FALLBACK_NOT_FOUND,
      InstructionDidNotDeserialize: errors.ANCHOR_ERROR__INSTRUCTION_DID_NOT_DESERIALIZE,
      InstructionDidNotSerialize: errors.ANCHOR_ERROR__INSTRUCTION_DID_NOT_SERIALIZE,
      // IDL instructions.
      /** @deprecated Legacy IDL error codes. Use Program Metadata instead. Will be removed in a future release. */
      IdlInstructionStub: errors.ANCHOR_ERROR__IDL_INSTRUCTION_STUB,
      /** @deprecated */
      IdlInstructionInvalidProgram: errors.ANCHOR_ERROR__IDL_INSTRUCTION_INVALID_PROGRAM,
      /** @deprecated */
      IdlAccountNotEmpty: errors.ANCHOR_ERROR__IDL_ACCOUNT_NOT_EMPTY,
      // Event instructions.
      EventInstructionStub: errors.ANCHOR_ERROR__EVENT_INSTRUCTION_STUB,
      // Constraints.
      ConstraintMut: errors.ANCHOR_ERROR__CONSTRAINT_MUT,
      ConstraintHasOne: errors.ANCHOR_ERROR__CONSTRAINT_HAS_ONE,
      ConstraintSigner: errors.ANCHOR_ERROR__CONSTRAINT_SIGNER,
      ConstraintRaw: errors.ANCHOR_ERROR__CONSTRAINT_RAW,
      ConstraintOwner: errors.ANCHOR_ERROR__CONSTRAINT_OWNER,
      ConstraintRentExempt: errors.ANCHOR_ERROR__CONSTRAINT_RENT_EXEMPT,
      ConstraintSeeds: errors.ANCHOR_ERROR__CONSTRAINT_SEEDS,
      ConstraintExecutable: errors.ANCHOR_ERROR__CONSTRAINT_EXECUTABLE,
      ConstraintState: errors.ANCHOR_ERROR__CONSTRAINT_STATE,
      ConstraintAssociated: errors.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED,
      ConstraintAssociatedInit: errors.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_INIT,
      ConstraintClose: errors.ANCHOR_ERROR__CONSTRAINT_CLOSE,
      ConstraintAddress: errors.ANCHOR_ERROR__CONSTRAINT_ADDRESS,
      ConstraintZero: errors.ANCHOR_ERROR__CONSTRAINT_ZERO,
      ConstraintTokenMint: errors.ANCHOR_ERROR__CONSTRAINT_TOKEN_MINT,
      ConstraintTokenOwner: errors.ANCHOR_ERROR__CONSTRAINT_TOKEN_OWNER,
      ConstraintMintMintAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_MINT_AUTHORITY,
      ConstraintMintFreezeAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_FREEZE_AUTHORITY,
      ConstraintMintDecimals: errors.ANCHOR_ERROR__CONSTRAINT_MINT_DECIMALS,
      ConstraintSpace: errors.ANCHOR_ERROR__CONSTRAINT_SPACE,
      ConstraintAccountIsNone: errors.ANCHOR_ERROR__CONSTRAINT_ACCOUNT_IS_NONE,
      ConstraintTokenTokenProgram: errors.ANCHOR_ERROR__CONSTRAINT_TOKEN_TOKEN_PROGRAM,
      ConstraintMintTokenProgram: errors.ANCHOR_ERROR__CONSTRAINT_MINT_TOKEN_PROGRAM,
      ConstraintAssociatedTokenTokenProgram: errors.ANCHOR_ERROR__CONSTRAINT_ASSOCIATED_TOKEN_TOKEN_PROGRAM,
      ConstraintMintGroupPointerExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION,
      ConstraintMintGroupPointerExtensionAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_AUTHORITY,
      ConstraintMintGroupPointerExtensionGroupAddress: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_POINTER_EXTENSION_GROUP_ADDRESS,
      ConstraintMintGroupMemberPointerExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION,
      ConstraintMintGroupMemberPointerExtensionAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_AUTHORITY,
      ConstraintMintGroupMemberPointerExtensionMemberAddress: errors.ANCHOR_ERROR__CONSTRAINT_MINT_GROUP_MEMBER_POINTER_EXTENSION_MEMBER_ADDRESS,
      ConstraintMintMetadataPointerExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION,
      ConstraintMintMetadataPointerExtensionAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_AUTHORITY,
      ConstraintMintMetadataPointerExtensionMetadataAddress: errors.ANCHOR_ERROR__CONSTRAINT_MINT_METADATA_POINTER_EXTENSION_METADATA_ADDRESS,
      ConstraintMintCloseAuthorityExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION,
      ConstraintMintCloseAuthorityExtensionAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_CLOSE_AUTHORITY_EXTENSION_AUTHORITY,
      ConstraintMintPermanentDelegateExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION,
      ConstraintMintPermanentDelegateExtensionDelegate: errors.ANCHOR_ERROR__CONSTRAINT_MINT_PERMANENT_DELEGATE_EXTENSION_DELEGATE,
      ConstraintMintTransferHookExtension: errors.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION,
      ConstraintMintTransferHookExtensionAuthority: errors.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_AUTHORITY,
      ConstraintMintTransferHookExtensionProgramId: errors.ANCHOR_ERROR__CONSTRAINT_MINT_TRANSFER_HOOK_EXTENSION_PROGRAM_ID,
      // Require.
      RequireViolated: errors.ANCHOR_ERROR__REQUIRE_VIOLATED,
      RequireEqViolated: errors.ANCHOR_ERROR__REQUIRE_EQ_VIOLATED,
      RequireKeysEqViolated: errors.ANCHOR_ERROR__REQUIRE_KEYS_EQ_VIOLATED,
      RequireNeqViolated: errors.ANCHOR_ERROR__REQUIRE_NEQ_VIOLATED,
      RequireKeysNeqViolated: errors.ANCHOR_ERROR__REQUIRE_KEYS_NEQ_VIOLATED,
      RequireGtViolated: errors.ANCHOR_ERROR__REQUIRE_GT_VIOLATED,
      RequireGteViolated: errors.ANCHOR_ERROR__REQUIRE_GTE_VIOLATED,
      // Accounts.
      AccountDiscriminatorAlreadySet: errors.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_ALREADY_SET,
      AccountDiscriminatorNotFound: errors.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_NOT_FOUND,
      AccountDiscriminatorMismatch: errors.ANCHOR_ERROR__ACCOUNT_DISCRIMINATOR_MISMATCH,
      AccountDidNotDeserialize: errors.ANCHOR_ERROR__ACCOUNT_DID_NOT_DESERIALIZE,
      AccountDidNotSerialize: errors.ANCHOR_ERROR__ACCOUNT_DID_NOT_SERIALIZE,
      AccountNotEnoughKeys: errors.ANCHOR_ERROR__ACCOUNT_NOT_ENOUGH_KEYS,
      AccountNotMutable: errors.ANCHOR_ERROR__ACCOUNT_NOT_MUTABLE,
      AccountOwnedByWrongProgram: errors.ANCHOR_ERROR__ACCOUNT_OWNED_BY_WRONG_PROGRAM,
      InvalidProgramId: errors.ANCHOR_ERROR__INVALID_PROGRAM_ID,
      InvalidProgramExecutable: errors.ANCHOR_ERROR__INVALID_PROGRAM_EXECUTABLE,
      AccountNotSigner: errors.ANCHOR_ERROR__ACCOUNT_NOT_SIGNER,
      AccountNotSystemOwned: errors.ANCHOR_ERROR__ACCOUNT_NOT_SYSTEM_OWNED,
      AccountNotInitialized: errors.ANCHOR_ERROR__ACCOUNT_NOT_INITIALIZED,
      AccountNotProgramData: errors.ANCHOR_ERROR__ACCOUNT_NOT_PROGRAM_DATA,
      AccountNotAssociatedTokenAccount: errors.ANCHOR_ERROR__ACCOUNT_NOT_ASSOCIATED_TOKEN_ACCOUNT,
      AccountSysvarMismatch: errors.ANCHOR_ERROR__ACCOUNT_SYSVAR_MISMATCH,
      AccountReallocExceedsLimit: errors.ANCHOR_ERROR__ACCOUNT_REALLOC_EXCEEDS_LIMIT,
      AccountDuplicateReallocs: errors.ANCHOR_ERROR__ACCOUNT_DUPLICATE_REALLOCS,
      // Miscellaneous
      DeclaredProgramIdMismatch: errors.ANCHOR_ERROR__DECLARED_PROGRAM_ID_MISMATCH,
      TryingToInitPayerAsProgramAccount: errors.ANCHOR_ERROR__TRYING_TO_INIT_PAYER_AS_PROGRAM_ACCOUNT,
      InvalidNumericConversion: errors.ANCHOR_ERROR__INVALID_NUMERIC_CONVERSION,
      // Used for APIs that shouldn't be used anymore.
      Deprecated: errors.ANCHOR_ERROR__DEPRECATED
    };
    exports.LangErrorMessage = /* @__PURE__ */ new Map([
      // Instructions.
      [exports.LangErrorCode.InstructionMissing, "Instruction discriminator not provided"],
      [
        exports.LangErrorCode.InstructionFallbackNotFound,
        "Fallback functions are not supported"
      ],
      [
        exports.LangErrorCode.InstructionDidNotDeserialize,
        "The program could not deserialize the given instruction"
      ],
      [
        exports.LangErrorCode.InstructionDidNotSerialize,
        "The program could not serialize the given instruction"
      ],
      // Idl instructions.
      [
        exports.LangErrorCode.IdlInstructionStub,
        "The program was compiled without idl instructions"
      ],
      [
        exports.LangErrorCode.IdlInstructionInvalidProgram,
        "The transaction was given an invalid program for the IDL instruction"
      ],
      [
        exports.LangErrorCode.IdlAccountNotEmpty,
        "IDL account must be empty in order to resize, try closing first"
      ],
      // Event instructions.
      [
        exports.LangErrorCode.EventInstructionStub,
        "The program was compiled without `event-cpi` feature"
      ],
      // Constraints.
      [exports.LangErrorCode.ConstraintMut, "A mut constraint was violated"],
      [exports.LangErrorCode.ConstraintHasOne, "A has one constraint was violated"],
      [exports.LangErrorCode.ConstraintSigner, "A signer constraint was violated"],
      [exports.LangErrorCode.ConstraintRaw, "A raw constraint was violated"],
      [exports.LangErrorCode.ConstraintOwner, "An owner constraint was violated"],
      [
        exports.LangErrorCode.ConstraintRentExempt,
        "A rent exemption constraint was violated"
      ],
      [exports.LangErrorCode.ConstraintSeeds, "A seeds constraint was violated"],
      [exports.LangErrorCode.ConstraintExecutable, "An executable constraint was violated"],
      [
        exports.LangErrorCode.ConstraintState,
        "Deprecated Error, feel free to replace with something else"
      ],
      [exports.LangErrorCode.ConstraintAssociated, "An associated constraint was violated"],
      [
        exports.LangErrorCode.ConstraintAssociatedInit,
        "An associated init constraint was violated"
      ],
      [exports.LangErrorCode.ConstraintClose, "A close constraint was violated"],
      [exports.LangErrorCode.ConstraintAddress, "An address constraint was violated"],
      [exports.LangErrorCode.ConstraintZero, "Expected zero account discriminant"],
      [exports.LangErrorCode.ConstraintTokenMint, "A token mint constraint was violated"],
      [exports.LangErrorCode.ConstraintTokenOwner, "A token owner constraint was violated"],
      [
        exports.LangErrorCode.ConstraintMintMintAuthority,
        "A mint mint authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintFreezeAuthority,
        "A mint freeze authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintDecimals,
        "A mint decimals constraint was violated"
      ],
      [exports.LangErrorCode.ConstraintSpace, "A space constraint was violated"],
      [
        exports.LangErrorCode.ConstraintAccountIsNone,
        "A required account for the constraint is None"
      ],
      [
        exports.LangErrorCode.ConstraintTokenTokenProgram,
        "A token account token program constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintTokenProgram,
        "A mint token program constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintAssociatedTokenTokenProgram,
        "An associated token account token program constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupPointerExtension,
        "A group pointer extension constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupPointerExtensionAuthority,
        "A group pointer extension authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupPointerExtensionGroupAddress,
        "A group pointer extension group address constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupMemberPointerExtension,
        "A group member pointer extension constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupMemberPointerExtensionAuthority,
        "A group member pointer extension authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintGroupMemberPointerExtensionMemberAddress,
        "A group member pointer extension group address constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintMetadataPointerExtension,
        "A metadata pointer extension constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintMetadataPointerExtensionAuthority,
        "A metadata pointer extension authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintMetadataPointerExtensionMetadataAddress,
        "A metadata pointer extension metadata address constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintCloseAuthorityExtension,
        "A close authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintCloseAuthorityExtensionAuthority,
        "A close authority extension authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintPermanentDelegateExtension,
        "A permanent delegate extension constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintPermanentDelegateExtensionDelegate,
        "A permanent delegate extension delegate constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintTransferHookExtension,
        "A transfer hook extension constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintTransferHookExtensionAuthority,
        "A transfer hook extension authority constraint was violated"
      ],
      [
        exports.LangErrorCode.ConstraintMintTransferHookExtensionProgramId,
        "A transfer hook extension transfer hook program id constraint was violated"
      ],
      // Require.
      [exports.LangErrorCode.RequireViolated, "A require expression was violated"],
      [exports.LangErrorCode.RequireEqViolated, "A require_eq expression was violated"],
      [
        exports.LangErrorCode.RequireKeysEqViolated,
        "A require_keys_eq expression was violated"
      ],
      [exports.LangErrorCode.RequireNeqViolated, "A require_neq expression was violated"],
      [
        exports.LangErrorCode.RequireKeysNeqViolated,
        "A require_keys_neq expression was violated"
      ],
      [exports.LangErrorCode.RequireGtViolated, "A require_gt expression was violated"],
      [exports.LangErrorCode.RequireGteViolated, "A require_gte expression was violated"],
      // Accounts.
      [
        exports.LangErrorCode.AccountDiscriminatorAlreadySet,
        "The account discriminator was already set on this account"
      ],
      [
        exports.LangErrorCode.AccountDiscriminatorNotFound,
        "No discriminator was found on the account"
      ],
      [
        exports.LangErrorCode.AccountDiscriminatorMismatch,
        "Account discriminator did not match what was expected"
      ],
      [exports.LangErrorCode.AccountDidNotDeserialize, "Failed to deserialize the account"],
      [exports.LangErrorCode.AccountDidNotSerialize, "Failed to serialize the account"],
      [
        exports.LangErrorCode.AccountNotEnoughKeys,
        "Not enough account keys given to the instruction"
      ],
      [exports.LangErrorCode.AccountNotMutable, "The given account is not mutable"],
      [
        exports.LangErrorCode.AccountOwnedByWrongProgram,
        "The given account is owned by a different program than expected"
      ],
      [exports.LangErrorCode.InvalidProgramId, "Program ID was not as expected"],
      [exports.LangErrorCode.InvalidProgramExecutable, "Program account is not executable"],
      [exports.LangErrorCode.AccountNotSigner, "The given account did not sign"],
      [
        exports.LangErrorCode.AccountNotSystemOwned,
        "The given account is not owned by the system program"
      ],
      [
        exports.LangErrorCode.AccountNotInitialized,
        "The program expected this account to be already initialized"
      ],
      [
        exports.LangErrorCode.AccountNotProgramData,
        "The given account is not a program data account"
      ],
      [
        exports.LangErrorCode.AccountNotAssociatedTokenAccount,
        "The given account is not the associated token account"
      ],
      [
        exports.LangErrorCode.AccountSysvarMismatch,
        "The given public key does not match the required sysvar"
      ],
      [
        exports.LangErrorCode.AccountReallocExceedsLimit,
        "The account reallocation exceeds the MAX_PERMITTED_DATA_INCREASE limit"
      ],
      [
        exports.LangErrorCode.AccountDuplicateReallocs,
        "The account was duplicated for more than one reallocation"
      ],
      // Miscellaneous
      [
        exports.LangErrorCode.DeclaredProgramIdMismatch,
        "The declared program id does not match the actual program id"
      ],
      [
        exports.LangErrorCode.TryingToInitPayerAsProgramAccount,
        "You cannot/should not initialize the payer account as a program account"
      ],
      [
        exports.LangErrorCode.InvalidNumericConversion,
        "The program could not perform the numeric conversion, out of range integral type conversion attempted"
      ],
      // Deprecated
      [
        exports.LangErrorCode.Deprecated,
        "The API being used is deprecated and should no longer be used"
      ]
    ]);
  }
});

// sdk/node_modules/.pnpm/buffer-layout@1.2.2/node_modules/buffer-layout/lib/Layout.js
var require_Layout = __commonJS({
  "sdk/node_modules/.pnpm/buffer-layout@1.2.2/node_modules/buffer-layout/lib/Layout.js"(exports) {
    "use strict";
    var Layout = class {
      constructor(span, property) {
        if (!Number.isInteger(span)) {
          throw new TypeError("span must be an integer");
        }
        this.span = span;
        this.property = property;
      }
      /** Function to create an Object into which decoded properties will
       * be written.
       *
       * Used only for layouts that {@link Layout#decode|decode} to Object
       * instances, which means:
       * * {@link Structure}
       * * {@link Union}
       * * {@link VariantLayout}
       * * {@link BitStructure}
       *
       * If left undefined the JavaScript representation of these layouts
       * will be Object instances.
       *
       * See {@link bindConstructorLayout}.
       */
      makeDestinationObject() {
        return {};
      }
      /**
       * Decode from a Buffer into an JavaScript value.
       *
       * @param {Buffer} b - the buffer from which encoded data is read.
       *
       * @param {Number} [offset] - the offset at which the encoded data
       * starts.  If absent a zero offset is inferred.
       *
       * @returns {(Number|Array|Object)} - the value of the decoded data.
       *
       * @abstract
       */
      decode(b, offset) {
        throw new Error("Layout is abstract");
      }
      /**
       * Encode a JavaScript value into a Buffer.
       *
       * @param {(Number|Array|Object)} src - the value to be encoded into
       * the buffer.  The type accepted depends on the (sub-)type of {@link
       * Layout}.
       *
       * @param {Buffer} b - the buffer into which encoded data will be
       * written.
       *
       * @param {Number} [offset] - the offset at which the encoded data
       * starts.  If absent a zero offset is inferred.
       *
       * @returns {Number} - the number of bytes encoded, including the
       * space skipped for internal padding, but excluding data such as
       * {@link Sequence#count|lengths} when stored {@link
       * ExternalLayout|externally}.  This is the adjustment to `offset`
       * producing the offset where data for the next layout would be
       * written.
       *
       * @abstract
       */
      encode(src, b, offset) {
        throw new Error("Layout is abstract");
      }
      /**
       * Calculate the span of a specific instance of a layout.
       *
       * @param {Buffer} b - the buffer that contains an encoded instance.
       *
       * @param {Number} [offset] - the offset at which the encoded instance
       * starts.  If absent a zero offset is inferred.
       *
       * @return {Number} - the number of bytes covered by the layout
       * instance.  If this method is not overridden in a subclass the
       * definition-time constant {@link Layout#span|span} will be
       * returned.
       *
       * @throws {RangeError} - if the length of the value cannot be
       * determined.
       */
      getSpan(b, offset) {
        if (0 > this.span) {
          throw new RangeError("indeterminate span");
        }
        return this.span;
      }
      /**
       * Replicate the layout using a new property.
       *
       * This function must be used to get a structurally-equivalent layout
       * with a different name since all {@link Layout} instances are
       * immutable.
       *
       * **NOTE** This is a shallow copy.  All fields except {@link
       * Layout#property|property} are strictly equal to the origin layout.
       *
       * @param {String} property - the value for {@link
       * Layout#property|property} in the replica.
       *
       * @returns {Layout} - the copy with {@link Layout#property|property}
       * set to `property`.
       */
      replicate(property) {
        const rv = Object.create(this.constructor.prototype);
        Object.assign(rv, this);
        rv.property = property;
        return rv;
      }
      /**
       * Create an object from layout properties and an array of values.
       *
       * **NOTE** This function returns `undefined` if invoked on a layout
       * that does not return its value as an Object.  Objects are
       * returned for things that are a {@link Structure}, which includes
       * {@link VariantLayout|variant layouts} if they are structures, and
       * excludes {@link Union}s.  If you want this feature for a union
       * you must use {@link Union.getVariant|getVariant} to select the
       * desired layout.
       *
       * @param {Array} values - an array of values that correspond to the
       * default order for properties.  As with {@link Layout#decode|decode}
       * layout elements that have no property name are skipped when
       * iterating over the array values.  Only the top-level properties are
       * assigned; arguments are not assigned to properties of contained
       * layouts.  Any unused values are ignored.
       *
       * @return {(Object|undefined)}
       */
      fromArray(values) {
        return void 0;
      }
    };
    exports.Layout = Layout;
    function nameWithProperty(name, lo) {
      if (lo.property) {
        return name + "[" + lo.property + "]";
      }
      return name;
    }
    exports.nameWithProperty = nameWithProperty;
    function bindConstructorLayout(Class, layout) {
      if ("function" !== typeof Class) {
        throw new TypeError("Class must be constructor");
      }
      if (Class.hasOwnProperty("layout_")) {
        throw new Error("Class is already bound to a layout");
      }
      if (!(layout && layout instanceof Layout)) {
        throw new TypeError("layout must be a Layout");
      }
      if (layout.hasOwnProperty("boundConstructor_")) {
        throw new Error("layout is already bound to a constructor");
      }
      Class.layout_ = layout;
      layout.boundConstructor_ = Class;
      layout.makeDestinationObject = (() => new Class());
      Object.defineProperty(Class.prototype, "encode", {
        value: function(b, offset) {
          return layout.encode(this, b, offset);
        },
        writable: true
      });
      Object.defineProperty(Class, "decode", {
        value: function(b, offset) {
          return layout.decode(b, offset);
        },
        writable: true
      });
    }
    exports.bindConstructorLayout = bindConstructorLayout;
    var ExternalLayout = class extends Layout {
      /**
       * Return `true` iff the external layout decodes to an unsigned
       * integer layout.
       *
       * In that case it can be used as the source of {@link
       * Sequence#count|Sequence counts}, {@link Blob#length|Blob lengths},
       * or as {@link UnionLayoutDiscriminator#layout|external union
       * discriminators}.
       *
       * @abstract
       */
      isCount() {
        throw new Error("ExternalLayout is abstract");
      }
    };
    var GreedyCount = class extends ExternalLayout {
      constructor(elementSpan, property) {
        if (void 0 === elementSpan) {
          elementSpan = 1;
        }
        if (!Number.isInteger(elementSpan) || 0 >= elementSpan) {
          throw new TypeError("elementSpan must be a (positive) integer");
        }
        super(-1, property);
        this.elementSpan = elementSpan;
      }
      /** @override */
      isCount() {
        return true;
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const rem = b.length - offset;
        return Math.floor(rem / this.elementSpan);
      }
      /** @override */
      encode(src, b, offset) {
        return 0;
      }
    };
    var OffsetLayout = class extends ExternalLayout {
      constructor(layout, offset, property) {
        if (!(layout instanceof Layout)) {
          throw new TypeError("layout must be a Layout");
        }
        if (void 0 === offset) {
          offset = 0;
        } else if (!Number.isInteger(offset)) {
          throw new TypeError("offset must be integer or undefined");
        }
        super(layout.span, property || layout.property);
        this.layout = layout;
        this.offset = offset;
      }
      /** @override */
      isCount() {
        return this.layout instanceof UInt || this.layout instanceof UIntBE;
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return this.layout.decode(b, offset + this.offset);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return this.layout.encode(src, b, offset + this.offset);
      }
    };
    var UInt = class extends Layout {
      constructor(span, property) {
        super(span, property);
        if (6 < this.span) {
          throw new RangeError("span must not exceed 6 bytes");
        }
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readUIntLE(offset, this.span);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeUIntLE(src, offset, this.span);
        return this.span;
      }
    };
    var UIntBE = class extends Layout {
      constructor(span, property) {
        super(span, property);
        if (6 < this.span) {
          throw new RangeError("span must not exceed 6 bytes");
        }
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readUIntBE(offset, this.span);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeUIntBE(src, offset, this.span);
        return this.span;
      }
    };
    var Int = class extends Layout {
      constructor(span, property) {
        super(span, property);
        if (6 < this.span) {
          throw new RangeError("span must not exceed 6 bytes");
        }
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readIntLE(offset, this.span);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeIntLE(src, offset, this.span);
        return this.span;
      }
    };
    var IntBE = class extends Layout {
      constructor(span, property) {
        super(span, property);
        if (6 < this.span) {
          throw new RangeError("span must not exceed 6 bytes");
        }
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readIntBE(offset, this.span);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeIntBE(src, offset, this.span);
        return this.span;
      }
    };
    var V2E32 = Math.pow(2, 32);
    function divmodInt64(src) {
      const hi32 = Math.floor(src / V2E32);
      const lo32 = src - hi32 * V2E32;
      return { hi32, lo32 };
    }
    function roundedInt64(hi32, lo32) {
      return hi32 * V2E32 + lo32;
    }
    var NearUInt64 = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const lo32 = b.readUInt32LE(offset);
        const hi32 = b.readUInt32LE(offset + 4);
        return roundedInt64(hi32, lo32);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const split = divmodInt64(src);
        b.writeUInt32LE(split.lo32, offset);
        b.writeUInt32LE(split.hi32, offset + 4);
        return 8;
      }
    };
    var NearUInt64BE = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const hi32 = b.readUInt32BE(offset);
        const lo32 = b.readUInt32BE(offset + 4);
        return roundedInt64(hi32, lo32);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const split = divmodInt64(src);
        b.writeUInt32BE(split.hi32, offset);
        b.writeUInt32BE(split.lo32, offset + 4);
        return 8;
      }
    };
    var NearInt64 = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const lo32 = b.readUInt32LE(offset);
        const hi32 = b.readInt32LE(offset + 4);
        return roundedInt64(hi32, lo32);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const split = divmodInt64(src);
        b.writeUInt32LE(split.lo32, offset);
        b.writeInt32LE(split.hi32, offset + 4);
        return 8;
      }
    };
    var NearInt64BE = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const hi32 = b.readInt32BE(offset);
        const lo32 = b.readUInt32BE(offset + 4);
        return roundedInt64(hi32, lo32);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const split = divmodInt64(src);
        b.writeInt32BE(split.hi32, offset);
        b.writeUInt32BE(split.lo32, offset + 4);
        return 8;
      }
    };
    var Float = class extends Layout {
      constructor(property) {
        super(4, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readFloatLE(offset);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeFloatLE(src, offset);
        return 4;
      }
    };
    var FloatBE = class extends Layout {
      constructor(property) {
        super(4, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readFloatBE(offset);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeFloatBE(src, offset);
        return 4;
      }
    };
    var Double = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readDoubleLE(offset);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeDoubleLE(src, offset);
        return 8;
      }
    };
    var DoubleBE = class extends Layout {
      constructor(property) {
        super(8, property);
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        return b.readDoubleBE(offset);
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        b.writeDoubleBE(src, offset);
        return 8;
      }
    };
    var Sequence = class extends Layout {
      constructor(elementLayout, count, property) {
        if (!(elementLayout instanceof Layout)) {
          throw new TypeError("elementLayout must be a Layout");
        }
        if (!(count instanceof ExternalLayout && count.isCount() || Number.isInteger(count) && 0 <= count)) {
          throw new TypeError("count must be non-negative integer or an unsigned integer ExternalLayout");
        }
        let span = -1;
        if (!(count instanceof ExternalLayout) && 0 < elementLayout.span) {
          span = count * elementLayout.span;
        }
        super(span, property);
        this.elementLayout = elementLayout;
        this.count = count;
      }
      /** @override */
      getSpan(b, offset) {
        if (0 <= this.span) {
          return this.span;
        }
        if (void 0 === offset) {
          offset = 0;
        }
        let span = 0;
        let count = this.count;
        if (count instanceof ExternalLayout) {
          count = count.decode(b, offset);
        }
        if (0 < this.elementLayout.span) {
          span = count * this.elementLayout.span;
        } else {
          let idx = 0;
          while (idx < count) {
            span += this.elementLayout.getSpan(b, offset + span);
            ++idx;
          }
        }
        return span;
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const rv = [];
        let i = 0;
        let count = this.count;
        if (count instanceof ExternalLayout) {
          count = count.decode(b, offset);
        }
        while (i < count) {
          rv.push(this.elementLayout.decode(b, offset));
          offset += this.elementLayout.getSpan(b, offset);
          i += 1;
        }
        return rv;
      }
      /** Implement {@link Layout#encode|encode} for {@link Sequence}.
       *
       * **NOTE** If `src` is shorter than {@link Sequence#count|count} then
       * the unused space in the buffer is left unchanged.  If `src` is
       * longer than {@link Sequence#count|count} the unneeded elements are
       * ignored.
       *
       * **NOTE** If {@link Layout#count|count} is an instance of {@link
       * ExternalLayout} then the length of `src` will be encoded as the
       * count after `src` is encoded. */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const elo = this.elementLayout;
        const span = src.reduce((span2, v) => {
          return span2 + elo.encode(v, b, offset + span2);
        }, 0);
        if (this.count instanceof ExternalLayout) {
          this.count.encode(src.length, b, offset);
        }
        return span;
      }
    };
    var Structure = class extends Layout {
      constructor(fields, property, decodePrefixes) {
        if (!(Array.isArray(fields) && fields.reduce((acc, v) => acc && v instanceof Layout, true))) {
          throw new TypeError("fields must be array of Layout instances");
        }
        if ("boolean" === typeof property && void 0 === decodePrefixes) {
          decodePrefixes = property;
          property = void 0;
        }
        for (const fd of fields) {
          if (0 > fd.span && void 0 === fd.property) {
            throw new Error("fields cannot contain unnamed variable-length layout");
          }
        }
        let span = -1;
        try {
          span = fields.reduce((span2, fd) => span2 + fd.getSpan(), 0);
        } catch (e) {
        }
        super(span, property);
        this.fields = fields;
        this.decodePrefixes = !!decodePrefixes;
      }
      /** @override */
      getSpan(b, offset) {
        if (0 <= this.span) {
          return this.span;
        }
        if (void 0 === offset) {
          offset = 0;
        }
        let span = 0;
        try {
          span = this.fields.reduce((span2, fd) => {
            const fsp = fd.getSpan(b, offset);
            offset += fsp;
            return span2 + fsp;
          }, 0);
        } catch (e) {
          throw new RangeError("indeterminate span");
        }
        return span;
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const dest = this.makeDestinationObject();
        for (const fd of this.fields) {
          if (void 0 !== fd.property) {
            dest[fd.property] = fd.decode(b, offset);
          }
          offset += fd.getSpan(b, offset);
          if (this.decodePrefixes && b.length === offset) {
            break;
          }
        }
        return dest;
      }
      /** Implement {@link Layout#encode|encode} for {@link Structure}.
       *
       * If `src` is missing a property for a member with a defined {@link
       * Layout#property|property} the corresponding region of the buffer is
       * left unmodified. */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const firstOffset = offset;
        let lastOffset = 0;
        let lastWrote = 0;
        for (const fd of this.fields) {
          let span = fd.span;
          lastWrote = 0 < span ? span : 0;
          if (void 0 !== fd.property) {
            const fv = src[fd.property];
            if (void 0 !== fv) {
              lastWrote = fd.encode(fv, b, offset);
              if (0 > span) {
                span = fd.getSpan(b, offset);
              }
            }
          }
          lastOffset = offset;
          offset += span;
        }
        return lastOffset + lastWrote - firstOffset;
      }
      /** @override */
      fromArray(values) {
        const dest = this.makeDestinationObject();
        for (const fd of this.fields) {
          if (void 0 !== fd.property && 0 < values.length) {
            dest[fd.property] = values.shift();
          }
        }
        return dest;
      }
      /**
       * Get access to the layout of a given property.
       *
       * @param {String} property - the structure member of interest.
       *
       * @return {Layout} - the layout associated with `property`, or
       * undefined if there is no such property.
       */
      layoutFor(property) {
        if ("string" !== typeof property) {
          throw new TypeError("property must be string");
        }
        for (const fd of this.fields) {
          if (fd.property === property) {
            return fd;
          }
        }
      }
      /**
       * Get the offset of a structure member.
       *
       * @param {String} property - the structure member of interest.
       *
       * @return {Number} - the offset in bytes to the start of `property`
       * within the structure, or undefined if `property` is not a field
       * within the structure.  If the property is a member but follows a
       * variable-length structure member a negative number will be
       * returned.
       */
      offsetOf(property) {
        if ("string" !== typeof property) {
          throw new TypeError("property must be string");
        }
        let offset = 0;
        for (const fd of this.fields) {
          if (fd.property === property) {
            return offset;
          }
          if (0 > fd.span) {
            offset = -1;
          } else if (0 <= offset) {
            offset += fd.span;
          }
        }
      }
    };
    var UnionDiscriminator = class {
      constructor(property) {
        this.property = property;
      }
      /** Analog to {@link Layout#decode|Layout decode} for union discriminators.
       *
       * The implementation of this method need not reference the buffer if
       * variant information is available through other means. */
      decode() {
        throw new Error("UnionDiscriminator is abstract");
      }
      /** Analog to {@link Layout#decode|Layout encode} for union discriminators.
       *
       * The implementation of this method need not store the value if
       * variant information is maintained through other means. */
      encode() {
        throw new Error("UnionDiscriminator is abstract");
      }
    };
    var UnionLayoutDiscriminator = class extends UnionDiscriminator {
      constructor(layout, property) {
        if (!(layout instanceof ExternalLayout && layout.isCount())) {
          throw new TypeError("layout must be an unsigned integer ExternalLayout");
        }
        super(property || layout.property || "variant");
        this.layout = layout;
      }
      /** Delegate decoding to {@link UnionLayoutDiscriminator#layout|layout}. */
      decode(b, offset) {
        return this.layout.decode(b, offset);
      }
      /** Delegate encoding to {@link UnionLayoutDiscriminator#layout|layout}. */
      encode(src, b, offset) {
        return this.layout.encode(src, b, offset);
      }
    };
    var Union = class extends Layout {
      constructor(discr, defaultLayout, property) {
        const upv = discr instanceof UInt || discr instanceof UIntBE;
        if (upv) {
          discr = new UnionLayoutDiscriminator(new OffsetLayout(discr));
        } else if (discr instanceof ExternalLayout && discr.isCount()) {
          discr = new UnionLayoutDiscriminator(discr);
        } else if (!(discr instanceof UnionDiscriminator)) {
          throw new TypeError("discr must be a UnionDiscriminator or an unsigned integer layout");
        }
        if (void 0 === defaultLayout) {
          defaultLayout = null;
        }
        if (!(null === defaultLayout || defaultLayout instanceof Layout)) {
          throw new TypeError("defaultLayout must be null or a Layout");
        }
        if (null !== defaultLayout) {
          if (0 > defaultLayout.span) {
            throw new Error("defaultLayout must have constant span");
          }
          if (void 0 === defaultLayout.property) {
            defaultLayout = defaultLayout.replicate("content");
          }
        }
        let span = -1;
        if (defaultLayout) {
          span = defaultLayout.span;
          if (0 <= span && upv) {
            span += discr.layout.span;
          }
        }
        super(span, property);
        this.discriminator = discr;
        this.usesPrefixDiscriminator = upv;
        this.defaultLayout = defaultLayout;
        this.registry = {};
        let boundGetSourceVariant = this.defaultGetSourceVariant.bind(this);
        this.getSourceVariant = function(src) {
          return boundGetSourceVariant(src);
        };
        this.configGetSourceVariant = function(gsv) {
          boundGetSourceVariant = gsv.bind(this);
        };
      }
      /** @override */
      getSpan(b, offset) {
        if (0 <= this.span) {
          return this.span;
        }
        if (void 0 === offset) {
          offset = 0;
        }
        const vlo = this.getVariant(b, offset);
        if (!vlo) {
          throw new Error("unable to determine span for unrecognized variant");
        }
        return vlo.getSpan(b, offset);
      }
      /**
       * Method to infer a registered Union variant compatible with `src`.
       *
       * The first satisified rule in the following sequence defines the
       * return value:
       * * If `src` has properties matching the Union discriminator and
       *   the default layout, `undefined` is returned regardless of the
       *   value of the discriminator property (this ensures the default
       *   layout will be used);
       * * If `src` has a property matching the Union discriminator, the
       *   value of the discriminator identifies a registered variant, and
       *   either (a) the variant has no layout, or (b) `src` has the
       *   variant's property, then the variant is returned (because the
       *   source satisfies the constraints of the variant it identifies);
       * * If `src` does not have a property matching the Union
       *   discriminator, but does have a property matching a registered
       *   variant, then the variant is returned (because the source
       *   matches a variant without an explicit conflict);
       * * An error is thrown (because we either can't identify a variant,
       *   or we were explicitly told the variant but can't satisfy it).
       *
       * @param {Object} src - an object presumed to be compatible with
       * the content of the Union.
       *
       * @return {(undefined|VariantLayout)} - as described above.
       *
       * @throws {Error} - if `src` cannot be associated with a default or
       * registered variant.
       */
      defaultGetSourceVariant(src) {
        if (src.hasOwnProperty(this.discriminator.property)) {
          if (this.defaultLayout && src.hasOwnProperty(this.defaultLayout.property)) {
            return void 0;
          }
          const vlo = this.registry[src[this.discriminator.property]];
          if (vlo && (!vlo.layout || src.hasOwnProperty(vlo.property))) {
            return vlo;
          }
        } else {
          for (const tag in this.registry) {
            const vlo = this.registry[tag];
            if (src.hasOwnProperty(vlo.property)) {
              return vlo;
            }
          }
        }
        throw new Error("unable to infer src variant");
      }
      /** Implement {@link Layout#decode|decode} for {@link Union}.
       *
       * If the variant is {@link Union#addVariant|registered} the return
       * value is an instance of that variant, with no explicit
       * discriminator.  Otherwise the {@link Union#defaultLayout|default
       * layout} is used to decode the content. */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        let dest;
        const dlo = this.discriminator;
        const discr = dlo.decode(b, offset);
        let clo = this.registry[discr];
        if (void 0 === clo) {
          let contentOffset = 0;
          clo = this.defaultLayout;
          if (this.usesPrefixDiscriminator) {
            contentOffset = dlo.layout.span;
          }
          dest = this.makeDestinationObject();
          dest[dlo.property] = discr;
          dest[clo.property] = this.defaultLayout.decode(b, offset + contentOffset);
        } else {
          dest = clo.decode(b, offset);
        }
        return dest;
      }
      /** Implement {@link Layout#encode|encode} for {@link Union}.
       *
       * This API assumes the `src` object is consistent with the union's
       * {@link Union#defaultLayout|default layout}.  To encode variants
       * use the appropriate variant-specific {@link VariantLayout#encode}
       * method. */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const vlo = this.getSourceVariant(src);
        if (void 0 === vlo) {
          const dlo = this.discriminator;
          const clo = this.defaultLayout;
          let contentOffset = 0;
          if (this.usesPrefixDiscriminator) {
            contentOffset = dlo.layout.span;
          }
          dlo.encode(src[dlo.property], b, offset);
          return contentOffset + clo.encode(
            src[clo.property],
            b,
            offset + contentOffset
          );
        }
        return vlo.encode(src, b, offset);
      }
      /** Register a new variant structure within a union.  The newly
       * created variant is returned.
       *
       * @param {Number} variant - initializer for {@link
       * VariantLayout#variant|variant}.
       *
       * @param {Layout} layout - initializer for {@link
       * VariantLayout#layout|layout}.
       *
       * @param {String} property - initializer for {@link
       * Layout#property|property}.
       *
       * @return {VariantLayout} */
      addVariant(variant, layout, property) {
        const rv = new VariantLayout(this, variant, layout, property);
        this.registry[variant] = rv;
        return rv;
      }
      /**
       * Get the layout associated with a registered variant.
       *
       * If `vb` does not produce a registered variant the function returns
       * `undefined`.
       *
       * @param {(Number|Buffer)} vb - either the variant number, or a
       * buffer from which the discriminator is to be read.
       *
       * @param {Number} offset - offset into `vb` for the start of the
       * union.  Used only when `vb` is an instance of {Buffer}.
       *
       * @return {({VariantLayout}|undefined)}
       */
      getVariant(vb, offset) {
        let variant = vb;
        if (Buffer.isBuffer(vb)) {
          if (void 0 === offset) {
            offset = 0;
          }
          variant = this.discriminator.decode(vb, offset);
        }
        return this.registry[variant];
      }
    };
    var VariantLayout = class extends Layout {
      constructor(union, variant, layout, property) {
        if (!(union instanceof Union)) {
          throw new TypeError("union must be a Union");
        }
        if (!Number.isInteger(variant) || 0 > variant) {
          throw new TypeError("variant must be a (non-negative) integer");
        }
        if ("string" === typeof layout && void 0 === property) {
          property = layout;
          layout = null;
        }
        if (layout) {
          if (!(layout instanceof Layout)) {
            throw new TypeError("layout must be a Layout");
          }
          if (null !== union.defaultLayout && 0 <= layout.span && layout.span > union.defaultLayout.span) {
            throw new Error("variant span exceeds span of containing union");
          }
          if ("string" !== typeof property) {
            throw new TypeError("variant must have a String property");
          }
        }
        let span = union.span;
        if (0 > union.span) {
          span = layout ? layout.span : 0;
          if (0 <= span && union.usesPrefixDiscriminator) {
            span += union.discriminator.layout.span;
          }
        }
        super(span, property);
        this.union = union;
        this.variant = variant;
        this.layout = layout || null;
      }
      /** @override */
      getSpan(b, offset) {
        if (0 <= this.span) {
          return this.span;
        }
        if (void 0 === offset) {
          offset = 0;
        }
        let contentOffset = 0;
        if (this.union.usesPrefixDiscriminator) {
          contentOffset = this.union.discriminator.layout.span;
        }
        return contentOffset + this.layout.getSpan(b, offset + contentOffset);
      }
      /** @override */
      decode(b, offset) {
        const dest = this.makeDestinationObject();
        if (void 0 === offset) {
          offset = 0;
        }
        if (this !== this.union.getVariant(b, offset)) {
          throw new Error("variant mismatch");
        }
        let contentOffset = 0;
        if (this.union.usesPrefixDiscriminator) {
          contentOffset = this.union.discriminator.layout.span;
        }
        if (this.layout) {
          dest[this.property] = this.layout.decode(b, offset + contentOffset);
        } else if (this.property) {
          dest[this.property] = true;
        } else if (this.union.usesPrefixDiscriminator) {
          dest[this.union.discriminator.property] = this.variant;
        }
        return dest;
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        let contentOffset = 0;
        if (this.union.usesPrefixDiscriminator) {
          contentOffset = this.union.discriminator.layout.span;
        }
        if (this.layout && !src.hasOwnProperty(this.property)) {
          throw new TypeError("variant lacks property " + this.property);
        }
        this.union.discriminator.encode(this.variant, b, offset);
        let span = contentOffset;
        if (this.layout) {
          this.layout.encode(src[this.property], b, offset + contentOffset);
          span += this.layout.getSpan(b, offset + contentOffset);
          if (0 <= this.union.span && span > this.union.span) {
            throw new Error("encoded variant overruns containing union");
          }
        }
        return span;
      }
      /** Delegate {@link Layout#fromArray|fromArray} to {@link
       * VariantLayout#layout|layout}. */
      fromArray(values) {
        if (this.layout) {
          return this.layout.fromArray(values);
        }
      }
    };
    function fixBitwiseResult(v) {
      if (0 > v) {
        v += 4294967296;
      }
      return v;
    }
    var BitStructure = class extends Layout {
      constructor(word, msb, property) {
        if (!(word instanceof UInt || word instanceof UIntBE)) {
          throw new TypeError("word must be a UInt or UIntBE layout");
        }
        if ("string" === typeof msb && void 0 === property) {
          property = msb;
          msb = void 0;
        }
        if (4 < word.span) {
          throw new RangeError("word cannot exceed 32 bits");
        }
        super(word.span, property);
        this.word = word;
        this.msb = !!msb;
        this.fields = [];
        let value = 0;
        this._packedSetValue = function(v) {
          value = fixBitwiseResult(v);
          return this;
        };
        this._packedGetValue = function() {
          return value;
        };
      }
      /** @override */
      decode(b, offset) {
        const dest = this.makeDestinationObject();
        if (void 0 === offset) {
          offset = 0;
        }
        const value = this.word.decode(b, offset);
        this._packedSetValue(value);
        for (const fd of this.fields) {
          if (void 0 !== fd.property) {
            dest[fd.property] = fd.decode(value);
          }
        }
        return dest;
      }
      /** Implement {@link Layout#encode|encode} for {@link BitStructure}.
       *
       * If `src` is missing a property for a member with a defined {@link
       * Layout#property|property} the corresponding region of the packed
       * value is left unmodified.  Unused bits are also left unmodified. */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        const value = this.word.decode(b, offset);
        this._packedSetValue(value);
        for (const fd of this.fields) {
          if (void 0 !== fd.property) {
            const fv = src[fd.property];
            if (void 0 !== fv) {
              fd.encode(fv);
            }
          }
        }
        return this.word.encode(this._packedGetValue(), b, offset);
      }
      /** Register a new bitfield with a containing bit structure.  The
       * resulting bitfield is returned.
       *
       * @param {Number} bits - initializer for {@link BitField#bits|bits}.
       *
       * @param {string} property - initializer for {@link
       * Layout#property|property}.
       *
       * @return {BitField} */
      addField(bits, property) {
        const bf = new BitField(this, bits, property);
        this.fields.push(bf);
        return bf;
      }
      /** As with {@link BitStructure#addField|addField} for single-bit
       * fields with `boolean` value representation.
       *
       * @param {string} property - initializer for {@link
       * Layout#property|property}.
       *
       * @return {Boolean} */
      addBoolean(property) {
        const bf = new Boolean2(this, property);
        this.fields.push(bf);
        return bf;
      }
      /**
       * Get access to the bit field for a given property.
       *
       * @param {String} property - the bit field of interest.
       *
       * @return {BitField} - the field associated with `property`, or
       * undefined if there is no such property.
       */
      fieldFor(property) {
        if ("string" !== typeof property) {
          throw new TypeError("property must be string");
        }
        for (const fd of this.fields) {
          if (fd.property === property) {
            return fd;
          }
        }
      }
    };
    var BitField = class {
      constructor(container, bits, property) {
        if (!(container instanceof BitStructure)) {
          throw new TypeError("container must be a BitStructure");
        }
        if (!Number.isInteger(bits) || 0 >= bits) {
          throw new TypeError("bits must be positive integer");
        }
        const totalBits = 8 * container.span;
        const usedBits = container.fields.reduce((sum, fd) => sum + fd.bits, 0);
        if (bits + usedBits > totalBits) {
          throw new Error("bits too long for span remainder (" + (totalBits - usedBits) + " of " + totalBits + " remain)");
        }
        this.container = container;
        this.bits = bits;
        this.valueMask = (1 << bits) - 1;
        if (32 === bits) {
          this.valueMask = 4294967295;
        }
        this.start = usedBits;
        if (this.container.msb) {
          this.start = totalBits - usedBits - bits;
        }
        this.wordMask = fixBitwiseResult(this.valueMask << this.start);
        this.property = property;
      }
      /** Store a value into the corresponding subsequence of the containing
       * bit field. */
      decode() {
        const word = this.container._packedGetValue();
        const wordValue = fixBitwiseResult(word & this.wordMask);
        const value = wordValue >>> this.start;
        return value;
      }
      /** Store a value into the corresponding subsequence of the containing
       * bit field.
       *
       * **NOTE** This is not a specialization of {@link
       * Layout#encode|Layout.encode} and there is no return value. */
      encode(value) {
        if (!Number.isInteger(value) || value !== fixBitwiseResult(value & this.valueMask)) {
          throw new TypeError(nameWithProperty("BitField.encode", this) + " value must be integer not exceeding " + this.valueMask);
        }
        const word = this.container._packedGetValue();
        const wordValue = fixBitwiseResult(value << this.start);
        this.container._packedSetValue(fixBitwiseResult(word & ~this.wordMask) | wordValue);
      }
    };
    var Boolean2 = class extends BitField {
      constructor(container, property) {
        super(container, 1, property);
      }
      /** Override {@link BitField#decode|decode} for {@link Boolean|Boolean}.
       *
       * @returns {boolean} */
      decode(b, offset) {
        return !!BitField.prototype.decode.call(this, b, offset);
      }
      /** @override */
      encode(value) {
        if ("boolean" === typeof value) {
          value = +value;
        }
        return BitField.prototype.encode.call(this, value);
      }
    };
    var Blob = class extends Layout {
      constructor(length, property) {
        if (!(length instanceof ExternalLayout && length.isCount() || Number.isInteger(length) && 0 <= length)) {
          throw new TypeError("length must be positive integer or an unsigned integer ExternalLayout");
        }
        let span = -1;
        if (!(length instanceof ExternalLayout)) {
          span = length;
        }
        super(span, property);
        this.length = length;
      }
      /** @override */
      getSpan(b, offset) {
        let span = this.span;
        if (0 > span) {
          span = this.length.decode(b, offset);
        }
        return span;
      }
      /** @override */
      decode(b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        let span = this.span;
        if (0 > span) {
          span = this.length.decode(b, offset);
        }
        return b.slice(offset, offset + span);
      }
      /** Implement {@link Layout#encode|encode} for {@link Blob}.
       *
       * **NOTE** If {@link Layout#count|count} is an instance of {@link
       * ExternalLayout} then the length of `src` will be encoded as the
       * count after `src` is encoded. */
      encode(src, b, offset) {
        let span = this.length;
        if (this.length instanceof ExternalLayout) {
          span = src.length;
        }
        if (!(Buffer.isBuffer(src) && span === src.length)) {
          throw new TypeError(nameWithProperty("Blob.encode", this) + " requires (length " + span + ") Buffer as src");
        }
        if (offset + span > b.length) {
          throw new RangeError("encoding overruns Buffer");
        }
        b.write(src.toString("hex"), offset, span, "hex");
        if (this.length instanceof ExternalLayout) {
          this.length.encode(span, b, offset);
        }
        return span;
      }
    };
    var CString = class extends Layout {
      constructor(property) {
        super(-1, property);
      }
      /** @override */
      getSpan(b, offset) {
        if (!Buffer.isBuffer(b)) {
          throw new TypeError("b must be a Buffer");
        }
        if (void 0 === offset) {
          offset = 0;
        }
        let idx = offset;
        while (idx < b.length && 0 !== b[idx]) {
          idx += 1;
        }
        return 1 + idx - offset;
      }
      /** @override */
      decode(b, offset, dest) {
        if (void 0 === offset) {
          offset = 0;
        }
        let span = this.getSpan(b, offset);
        return b.slice(offset, offset + span - 1).toString("utf-8");
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        if ("string" !== typeof src) {
          src = src.toString();
        }
        const srcb = new Buffer(src, "utf8");
        const span = srcb.length;
        if (offset + span > b.length) {
          throw new RangeError("encoding overruns Buffer");
        }
        srcb.copy(b, offset);
        b[offset + span] = 0;
        return span + 1;
      }
    };
    var UTF8 = class extends Layout {
      constructor(maxSpan, property) {
        if ("string" === typeof maxSpan && void 0 === property) {
          property = maxSpan;
          maxSpan = void 0;
        }
        if (void 0 === maxSpan) {
          maxSpan = -1;
        } else if (!Number.isInteger(maxSpan)) {
          throw new TypeError("maxSpan must be an integer");
        }
        super(-1, property);
        this.maxSpan = maxSpan;
      }
      /** @override */
      getSpan(b, offset) {
        if (!Buffer.isBuffer(b)) {
          throw new TypeError("b must be a Buffer");
        }
        if (void 0 === offset) {
          offset = 0;
        }
        return b.length - offset;
      }
      /** @override */
      decode(b, offset, dest) {
        if (void 0 === offset) {
          offset = 0;
        }
        let span = this.getSpan(b, offset);
        if (0 <= this.maxSpan && this.maxSpan < span) {
          throw new RangeError("text length exceeds maxSpan");
        }
        return b.slice(offset, offset + span).toString("utf-8");
      }
      /** @override */
      encode(src, b, offset) {
        if (void 0 === offset) {
          offset = 0;
        }
        if ("string" !== typeof src) {
          src = src.toString();
        }
        const srcb = new Buffer(src, "utf8");
        const span = srcb.length;
        if (0 <= this.maxSpan && this.maxSpan < span) {
          throw new RangeError("text length exceeds maxSpan");
        }
        if (offset + span > b.length) {
          throw new RangeError("encoding overruns Buffer");
        }
        srcb.copy(b, offset);
        return span;
      }
    };
    var Constant = class extends Layout {
      constructor(value, property) {
        super(0, property);
        this.value = value;
      }
      /** @override */
      decode(b, offset, dest) {
        return this.value;
      }
      /** @override */
      encode(src, b, offset) {
        return 0;
      }
    };
    exports.ExternalLayout = ExternalLayout;
    exports.GreedyCount = GreedyCount;
    exports.OffsetLayout = OffsetLayout;
    exports.UInt = UInt;
    exports.UIntBE = UIntBE;
    exports.Int = Int;
    exports.IntBE = IntBE;
    exports.Float = Float;
    exports.FloatBE = FloatBE;
    exports.Double = Double;
    exports.DoubleBE = DoubleBE;
    exports.Sequence = Sequence;
    exports.Structure = Structure;
    exports.UnionDiscriminator = UnionDiscriminator;
    exports.UnionLayoutDiscriminator = UnionLayoutDiscriminator;
    exports.Union = Union;
    exports.VariantLayout = VariantLayout;
    exports.BitStructure = BitStructure;
    exports.BitField = BitField;
    exports.Boolean = Boolean2;
    exports.Blob = Blob;
    exports.CString = CString;
    exports.UTF8 = UTF8;
    exports.Constant = Constant;
    exports.greedy = ((elementSpan, property) => new GreedyCount(elementSpan, property));
    exports.offset = ((layout, offset, property) => new OffsetLayout(layout, offset, property));
    exports.u8 = ((property) => new UInt(1, property));
    exports.u16 = ((property) => new UInt(2, property));
    exports.u24 = ((property) => new UInt(3, property));
    exports.u32 = ((property) => new UInt(4, property));
    exports.u40 = ((property) => new UInt(5, property));
    exports.u48 = ((property) => new UInt(6, property));
    exports.nu64 = ((property) => new NearUInt64(property));
    exports.u16be = ((property) => new UIntBE(2, property));
    exports.u24be = ((property) => new UIntBE(3, property));
    exports.u32be = ((property) => new UIntBE(4, property));
    exports.u40be = ((property) => new UIntBE(5, property));
    exports.u48be = ((property) => new UIntBE(6, property));
    exports.nu64be = ((property) => new NearUInt64BE(property));
    exports.s8 = ((property) => new Int(1, property));
    exports.s16 = ((property) => new Int(2, property));
    exports.s24 = ((property) => new Int(3, property));
    exports.s32 = ((property) => new Int(4, property));
    exports.s40 = ((property) => new Int(5, property));
    exports.s48 = ((property) => new Int(6, property));
    exports.ns64 = ((property) => new NearInt64(property));
    exports.s16be = ((property) => new IntBE(2, property));
    exports.s24be = ((property) => new IntBE(3, property));
    exports.s32be = ((property) => new IntBE(4, property));
    exports.s40be = ((property) => new IntBE(5, property));
    exports.s48be = ((property) => new IntBE(6, property));
    exports.ns64be = ((property) => new NearInt64BE(property));
    exports.f32 = ((property) => new Float(property));
    exports.f32be = ((property) => new FloatBE(property));
    exports.f64 = ((property) => new Double(property));
    exports.f64be = ((property) => new DoubleBE(property));
    exports.struct = ((fields, property, decodePrefixes) => new Structure(fields, property, decodePrefixes));
    exports.bits = ((word, msb, property) => new BitStructure(word, msb, property));
    exports.seq = ((elementLayout, count, property) => new Sequence(elementLayout, count, property));
    exports.union = ((discr, defaultLayout, property) => new Union(discr, defaultLayout, property));
    exports.unionLayoutDiscriminator = ((layout, property) => new UnionLayoutDiscriminator(layout, property));
    exports.blob = ((length, property) => new Blob(length, property));
    exports.cstr = ((property) => new CString(property));
    exports.utf8 = ((maxSpan, property) => new UTF8(maxSpan, property));
    exports.const = ((value, property) => new Constant(value, property));
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+borsh@1.2.1_@solana+web3.js@1.98.4_bufferutil@4.1.0_typescript@5.9.2_/node_modules/@anchor-lang/borsh/dist/index.js
var require_dist2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+borsh@1.2.1_@solana+web3.js@1.98.4_bufferutil@4.1.0_typescript@5.9.2_/node_modules/@anchor-lang/borsh/dist/index.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.map = exports.array = exports.rustEnum = exports.str = exports.vecU8 = exports.tagged = exports.vec = exports.bool = exports.option = exports.publicKey = exports.i256 = exports.u256 = exports.i128 = exports.u128 = exports.i64 = exports.u64 = exports.struct = exports.f64 = exports.f32 = exports.i32 = exports.u32 = exports.i16 = exports.u16 = exports.i8 = exports.u8 = void 0;
    var buffer_layout_1 = require_Layout();
    var web3_js_1 = __require("@solana/web3.js");
    var bn_js_1 = __importDefault(require_bn());
    var buffer_layout_2 = require_Layout();
    Object.defineProperty(exports, "u8", { enumerable: true, get: function() {
      return buffer_layout_2.u8;
    } });
    Object.defineProperty(exports, "i8", { enumerable: true, get: function() {
      return buffer_layout_2.s8;
    } });
    Object.defineProperty(exports, "u16", { enumerable: true, get: function() {
      return buffer_layout_2.u16;
    } });
    Object.defineProperty(exports, "i16", { enumerable: true, get: function() {
      return buffer_layout_2.s16;
    } });
    Object.defineProperty(exports, "u32", { enumerable: true, get: function() {
      return buffer_layout_2.u32;
    } });
    Object.defineProperty(exports, "i32", { enumerable: true, get: function() {
      return buffer_layout_2.s32;
    } });
    Object.defineProperty(exports, "f32", { enumerable: true, get: function() {
      return buffer_layout_2.f32;
    } });
    Object.defineProperty(exports, "f64", { enumerable: true, get: function() {
      return buffer_layout_2.f64;
    } });
    Object.defineProperty(exports, "struct", { enumerable: true, get: function() {
      return buffer_layout_2.struct;
    } });
    var BNLayout = class extends buffer_layout_1.Layout {
      constructor(span, signed, property) {
        super(span, property);
        this.blob = (0, buffer_layout_1.blob)(span);
        this.signed = signed;
      }
      decode(b, offset = 0) {
        const num2 = new bn_js_1.default(this.blob.decode(b, offset), 10, "le");
        if (this.signed) {
          return num2.fromTwos(this.span * 8).clone();
        }
        return num2;
      }
      encode(src, b, offset = 0) {
        if (this.signed) {
          src = src.toTwos(this.span * 8);
        }
        return this.blob.encode(src.toArrayLike(Buffer, "le", this.span), b, offset);
      }
    };
    function u64(property) {
      return new BNLayout(8, false, property);
    }
    exports.u64 = u64;
    function i64(property) {
      return new BNLayout(8, true, property);
    }
    exports.i64 = i64;
    function u128(property) {
      return new BNLayout(16, false, property);
    }
    exports.u128 = u128;
    function i128(property) {
      return new BNLayout(16, true, property);
    }
    exports.i128 = i128;
    function u256(property) {
      return new BNLayout(32, false, property);
    }
    exports.u256 = u256;
    function i256(property) {
      return new BNLayout(32, true, property);
    }
    exports.i256 = i256;
    var WrappedLayout = class extends buffer_layout_1.Layout {
      constructor(layout, decoder, encoder, property) {
        super(layout.span, property);
        this.layout = layout;
        this.decoder = decoder;
        this.encoder = encoder;
      }
      decode(b, offset) {
        return this.decoder(this.layout.decode(b, offset));
      }
      encode(src, b, offset) {
        return this.layout.encode(this.encoder(src), b, offset);
      }
      getSpan(b, offset) {
        return this.layout.getSpan(b, offset);
      }
    };
    function publicKey(property) {
      return new WrappedLayout((0, buffer_layout_1.blob)(32), (b) => new web3_js_1.PublicKey(b), (key2) => key2.toBuffer(), property);
    }
    exports.publicKey = publicKey;
    var OptionLayout = class extends buffer_layout_1.Layout {
      constructor(layout, property) {
        super(-1, property);
        this.layout = layout;
        this.discriminator = (0, buffer_layout_1.u8)();
      }
      encode(src, b, offset = 0) {
        if (src === null || src === void 0) {
          return this.discriminator.encode(0, b, offset);
        }
        this.discriminator.encode(1, b, offset);
        return this.layout.encode(src, b, offset + 1) + 1;
      }
      decode(b, offset = 0) {
        const discriminator = this.discriminator.decode(b, offset);
        if (discriminator === 0) {
          return null;
        } else if (discriminator === 1) {
          return this.layout.decode(b, offset + 1);
        }
        throw new Error("Invalid option " + this.property);
      }
      getSpan(b, offset = 0) {
        const discriminator = this.discriminator.decode(b, offset);
        if (discriminator === 0) {
          return 1;
        } else if (discriminator === 1) {
          return this.layout.getSpan(b, offset + 1) + 1;
        }
        throw new Error("Invalid option " + this.property);
      }
    };
    function option(layout, property) {
      return new OptionLayout(layout, property);
    }
    exports.option = option;
    function bool(property) {
      return new WrappedLayout((0, buffer_layout_1.u8)(), decodeBool, encodeBool, property);
    }
    exports.bool = bool;
    function decodeBool(value) {
      if (value === 0) {
        return false;
      } else if (value === 1) {
        return true;
      }
      throw new Error("Invalid bool: " + value);
    }
    function encodeBool(value) {
      return value ? 1 : 0;
    }
    var U32_SPAN = 4;
    var MAX_U32 = 4294967295;
    function formatProperty(property) {
      return property ? ` for "${property}"` : "";
    }
    function assertReadableBytes(b, offset, size, kind, property) {
      const remaining = Math.max(0, b.length - offset);
      if (offset < 0 || size < 0 || remaining < size) {
        throw new RangeError(`Invalid ${kind}${formatProperty(property)}: need ${size} bytes, only ${remaining} remaining bytes`);
      }
    }
    function assertWritableLength(length, kind, property) {
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_U32) {
        throw new RangeError(`Invalid ${kind}${formatProperty(property)}: length ${length} is outside the supported u32 range`);
      }
    }
    function readU32Length(b, offset, kind, property) {
      assertReadableBytes(b, offset, U32_SPAN, kind, property);
      return (0, buffer_layout_1.u32)().decode(b, offset);
    }
    function assertCollectionFitsRemaining(count, elementLayout, remainingBytes, kind, property) {
      if (elementLayout.span > 0) {
        const requiredBytes = count * elementLayout.span;
        if (!Number.isSafeInteger(requiredBytes) || requiredBytes > remainingBytes) {
          throw new RangeError(`Invalid ${kind}${formatProperty(property)}: length ${count} requires ${requiredBytes} bytes, only ${remainingBytes} remaining bytes`);
        }
        return;
      }
      if (elementLayout.span < 0 && count > remainingBytes) {
        throw new RangeError(`Invalid ${kind}${formatProperty(property)}: length ${count} exceeds ${remainingBytes} remaining bytes`);
      }
    }
    function decodeCollectionValues(count, elementLayout, b, offset, kind, property) {
      const remainingBytes = Math.max(0, b.length - offset);
      assertCollectionFitsRemaining(count, elementLayout, remainingBytes, kind, property);
      const values = [];
      let cursor = offset;
      for (let i = 0; i < count; i += 1) {
        const value = elementLayout.decode(b, cursor);
        const span = elementLayout.getSpan(b, cursor);
        if (!Number.isSafeInteger(span) || span < 0) {
          throw new RangeError(`Invalid ${kind}${formatProperty(property)}: element ${i} has invalid span ${span}`);
        }
        cursor += span;
        if (cursor > b.length) {
          throw new RangeError(`Invalid ${kind}${formatProperty(property)}: decoded past the end of the buffer`);
        }
        values.push(value);
      }
      return { values, span: cursor - offset };
    }
    function measureCollectionSpan(count, elementLayout, b, offset, kind, property) {
      const remainingBytes = Math.max(0, b.length - offset);
      assertCollectionFitsRemaining(count, elementLayout, remainingBytes, kind, property);
      if (elementLayout.span > 0) {
        return count * elementLayout.span;
      }
      let cursor = offset;
      for (let i = 0; i < count; i += 1) {
        const span = elementLayout.getSpan(b, cursor);
        if (!Number.isSafeInteger(span) || span < 0) {
          throw new RangeError(`Invalid ${kind}${formatProperty(property)}: element ${i} has invalid span ${span}`);
        }
        cursor += span;
        if (cursor > b.length) {
          throw new RangeError(`Invalid ${kind}${formatProperty(property)}: decoded past the end of the buffer`);
        }
      }
      return cursor - offset;
    }
    var VecLayout = class extends buffer_layout_1.Layout {
      constructor(elementLayout, property) {
        super(-1, property);
        this.elementLayout = elementLayout;
      }
      encode(src, b, offset = 0) {
        assertWritableLength(src.length, "vec", this.property);
        let cursor = offset;
        cursor += (0, buffer_layout_1.u32)().encode(src.length, b, cursor);
        for (const value of src) {
          cursor += this.elementLayout.encode(value, b, cursor);
        }
        return cursor - offset;
      }
      decode(b, offset = 0) {
        const count = readU32Length(b, offset, "vec", this.property);
        const dataOffset = offset + U32_SPAN;
        return decodeCollectionValues(count, this.elementLayout, b, dataOffset, "vec", this.property).values;
      }
      getSpan(b, offset = 0) {
        const count = readU32Length(b, offset, "vec", this.property);
        return U32_SPAN + measureCollectionSpan(count, this.elementLayout, b, offset + U32_SPAN, "vec", this.property);
      }
    };
    var BytesLayout = class extends buffer_layout_1.Layout {
      constructor(property) {
        super(-1, property);
      }
      encode(src, b, offset = 0) {
        assertWritableLength(src.length, "bytes", this.property);
        let cursor = offset;
        cursor += (0, buffer_layout_1.u32)().encode(src.length, b, cursor);
        assertReadableBytes(b, cursor, src.length, "bytes", this.property);
        src.copy(b, cursor);
        return U32_SPAN + src.length;
      }
      decode(b, offset = 0) {
        const length = readU32Length(b, offset, "bytes", this.property);
        const dataOffset = offset + U32_SPAN;
        const remainingBytes = Math.max(0, b.length - dataOffset);
        if (length > remainingBytes) {
          throw new RangeError(`Invalid bytes${formatProperty(this.property)}: length ${length} exceeds ${remainingBytes} remaining bytes`);
        }
        return b.subarray(dataOffset, dataOffset + length);
      }
      getSpan(b, offset = 0) {
        const length = readU32Length(b, offset, "bytes", this.property);
        const remainingBytes = Math.max(0, b.length - (offset + U32_SPAN));
        if (length > remainingBytes) {
          throw new RangeError(`Invalid bytes${formatProperty(this.property)}: length ${length} exceeds ${remainingBytes} remaining bytes`);
        }
        return U32_SPAN + length;
      }
    };
    var FixedArrayLayout = class extends buffer_layout_1.Layout {
      constructor(elementLayout, length, property) {
        assertWritableLength(length, "array", property);
        const span = elementLayout.span > 0 && Number.isSafeInteger(elementLayout.span * length) ? elementLayout.span * length : -1;
        super(span, property);
        this.elementLayout = elementLayout;
        this.length = length;
      }
      encode(src, b, offset = 0) {
        if (src.length !== this.length) {
          throw new RangeError(`Invalid array${formatProperty(this.property)}: expected ${this.length} items, received ${src.length}`);
        }
        let cursor = offset;
        for (const value of src) {
          cursor += this.elementLayout.encode(value, b, cursor);
        }
        return cursor - offset;
      }
      decode(b, offset = 0) {
        return decodeCollectionValues(this.length, this.elementLayout, b, offset, "array", this.property).values;
      }
      getSpan(b, offset = 0) {
        return measureCollectionSpan(this.length, this.elementLayout, b, offset, "array", this.property);
      }
    };
    function vec(elementLayout, property) {
      return new VecLayout(elementLayout, property);
    }
    exports.vec = vec;
    function tagged(tag, layout, property) {
      const wrappedLayout = (0, buffer_layout_1.struct)([
        u64("tag"),
        layout.replicate("data")
      ]);
      function decodeTag({ tag: receivedTag, data }) {
        if (!receivedTag.eq(tag)) {
          throw new Error("Invalid tag, expected: " + tag.toString("hex") + ", got: " + receivedTag.toString("hex"));
        }
        return data;
      }
      return new WrappedLayout(wrappedLayout, decodeTag, (data) => ({ tag, data }), property);
    }
    exports.tagged = tagged;
    function vecU8(property) {
      return new BytesLayout(property);
    }
    exports.vecU8 = vecU8;
    function str(property) {
      return new WrappedLayout(vecU8(), (data) => data.toString("utf-8"), (s) => Buffer.from(s, "utf-8"), property);
    }
    exports.str = str;
    function rustEnum(variants, property, discriminant) {
      const unionLayout = (0, buffer_layout_1.union)(discriminant !== null && discriminant !== void 0 ? discriminant : (0, buffer_layout_1.u8)(), property);
      variants.forEach((variant, index) => unionLayout.addVariant(index, variant, variant.property));
      return unionLayout;
    }
    exports.rustEnum = rustEnum;
    function array(elementLayout, length, property) {
      return new FixedArrayLayout(elementLayout, length, property);
    }
    exports.array = array;
    var MapEntryLayout = class extends buffer_layout_1.Layout {
      constructor(keyLayout, valueLayout, property) {
        const span = keyLayout.span >= 0 && valueLayout.span >= 0 && Number.isSafeInteger(keyLayout.span + valueLayout.span) ? keyLayout.span + valueLayout.span : -1;
        super(span, property);
        this.keyLayout = keyLayout;
        this.valueLayout = valueLayout;
      }
      decode(b, offset) {
        offset = offset || 0;
        const key2 = this.keyLayout.decode(b, offset);
        const value = this.valueLayout.decode(b, offset + this.keyLayout.getSpan(b, offset));
        return [key2, value];
      }
      encode(src, b, offset) {
        offset = offset || 0;
        const keyBytes = this.keyLayout.encode(src[0], b, offset);
        const valueBytes = this.valueLayout.encode(src[1], b, offset + keyBytes);
        return keyBytes + valueBytes;
      }
      getSpan(b, offset) {
        offset = offset || 0;
        const keySpan = this.keyLayout.getSpan(b, offset);
        return keySpan + this.valueLayout.getSpan(b, offset + keySpan);
      }
    };
    var MapLayout = class extends buffer_layout_1.Layout {
      constructor(keyLayout, valueLayout, property) {
        super(-1, property);
        this.entryLayout = new MapEntryLayout(keyLayout, valueLayout);
      }
      encode(src, b, offset = 0) {
        const entries = Array.from(src.entries());
        assertWritableLength(entries.length, "map", this.property);
        let cursor = offset;
        cursor += (0, buffer_layout_1.u32)().encode(entries.length, b, cursor);
        for (const entry of entries) {
          cursor += this.entryLayout.encode(entry, b, cursor);
        }
        return cursor - offset;
      }
      decode(b, offset = 0) {
        const count = readU32Length(b, offset, "map", this.property);
        const values = decodeCollectionValues(count, this.entryLayout, b, offset + U32_SPAN, "map", this.property).values;
        return new Map(values);
      }
      getSpan(b, offset = 0) {
        const count = readU32Length(b, offset, "map", this.property);
        return U32_SPAN + measureCollectionSpan(count, this.entryLayout, b, offset + U32_SPAN, "map", this.property);
      }
    };
    function map(keyLayout, valueLayout, property) {
      return new MapLayout(keyLayout, valueLayout, property);
    }
    exports.map = map;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/idl.js
var require_idl2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/idl.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IdlCoder = void 0;
    var buffer_layout_1 = require_Layout();
    var borsh = __importStar(require_dist2());
    var idl_js_1 = require_idl();
    var error_js_1 = require_error();
    var MAX_LAZY_LAYOUT_RECURSION_DEPTH = 256;
    var LazyDefinedLayout = class _LazyDefinedLayout extends buffer_layout_1.Layout {
      constructor(buildLayout, property) {
        super(-1, property);
        this.buildLayout = buildLayout;
      }
      get layout() {
        if (!this.resolvedLayout) {
          this.resolvedLayout = this.buildLayout();
        }
        return this.resolvedLayout;
      }
      withRecursionGuard(cb) {
        if (_LazyDefinedLayout.recursionDepth >= MAX_LAZY_LAYOUT_RECURSION_DEPTH) {
          throw new error_js_1.IdlError(`Recursive IDL layout exceeded maximum depth: ${this.property}`);
        }
        _LazyDefinedLayout.recursionDepth += 1;
        try {
          return cb();
        } finally {
          _LazyDefinedLayout.recursionDepth -= 1;
        }
      }
      decode(b, offset) {
        return this.withRecursionGuard(() => this.layout.decode(b, offset));
      }
      encode(src, b, offset) {
        return this.withRecursionGuard(() => this.layout.encode(src, b, offset));
      }
      getSpan(b, offset) {
        return this.withRecursionGuard(() => this.layout.getSpan(b, offset));
      }
      replicate(name) {
        return new _LazyDefinedLayout(this.buildLayout, name);
      }
    };
    LazyDefinedLayout.recursionDepth = 0;
    var IdlCoder = class _IdlCoder {
      static fieldLayout(field, types = [], genericArgs) {
        return _IdlCoder.fieldLayoutWithContext(field, types, genericArgs);
      }
      static fieldLayoutWithContext(field, types = [], genericArgs, definedTypeStack = [], allowRecursive = false) {
        const fieldName = field.name;
        switch (field.type) {
          case "bool": {
            return borsh.bool(fieldName);
          }
          case "u8": {
            return borsh.u8(fieldName);
          }
          case "i8": {
            return borsh.i8(fieldName);
          }
          case "u16": {
            return borsh.u16(fieldName);
          }
          case "i16": {
            return borsh.i16(fieldName);
          }
          case "u32": {
            return borsh.u32(fieldName);
          }
          case "i32": {
            return borsh.i32(fieldName);
          }
          case "f32": {
            return borsh.f32(fieldName);
          }
          case "u64": {
            return borsh.u64(fieldName);
          }
          case "i64": {
            return borsh.i64(fieldName);
          }
          case "f64": {
            return borsh.f64(fieldName);
          }
          case "u128": {
            return borsh.u128(fieldName);
          }
          case "i128": {
            return borsh.i128(fieldName);
          }
          case "u256": {
            return borsh.u256(fieldName);
          }
          case "i256": {
            return borsh.i256(fieldName);
          }
          case "bytes": {
            return borsh.vecU8(fieldName);
          }
          case "string": {
            return borsh.str(fieldName);
          }
          case "pubkey": {
            return borsh.publicKey(fieldName);
          }
          default: {
            if ("option" in field.type) {
              return borsh.option(_IdlCoder.fieldLayoutWithContext({ type: field.type.option }, types, genericArgs, definedTypeStack, true), fieldName);
            }
            if ("vec" in field.type) {
              return borsh.vec(_IdlCoder.fieldLayoutWithContext({ type: field.type.vec }, types, genericArgs, definedTypeStack, true), fieldName);
            }
            if ("array" in field.type) {
              let [type, len] = field.type.array;
              len = _IdlCoder.resolveArrayLen(len, genericArgs);
              return borsh.array(_IdlCoder.fieldLayoutWithContext({ type }, types, genericArgs, definedTypeStack, allowRecursive), len, fieldName);
            }
            if ("defined" in field.type) {
              if (!types) {
                throw new error_js_1.IdlError("User defined types not provided");
              }
              const definedName = field.type.defined.name;
              const typeDef = types.find((t) => t.name === definedName);
              if (!typeDef) {
                throw new error_js_1.IdlError(`Type not found: ${field.name}`);
              }
              const fieldGenericArgs = genericArgs !== null && genericArgs !== void 0 ? genericArgs : field.type.defined.generics;
              const layout = () => _IdlCoder.typeDefLayoutWithContext({
                typeDef,
                types,
                genericArgs: fieldGenericArgs,
                name: fieldName
              });
              if (definedTypeStack.includes(definedName)) {
                if (!allowRecursive) {
                  throw new error_js_1.IdlError(`Recursive type must be wrapped in an option or vector: ${definedName}`);
                }
                return new LazyDefinedLayout(layout, fieldName);
              }
              return _IdlCoder.typeDefLayoutWithContext({
                typeDef,
                types,
                genericArgs: fieldGenericArgs,
                name: fieldName,
                definedTypeStack: [...definedTypeStack, definedName]
              });
            }
            if ("generic" in field.type) {
              const genericArg = genericArgs === null || genericArgs === void 0 ? void 0 : genericArgs.at(0);
              if ((genericArg === null || genericArg === void 0 ? void 0 : genericArg.kind) !== "type") {
                throw new error_js_1.IdlError(`Invalid generic field: ${field.name}`);
              }
              return _IdlCoder.fieldLayoutWithContext({ ...field, type: genericArg.type }, types, void 0, definedTypeStack, allowRecursive);
            }
            throw new error_js_1.IdlError(`Not yet implemented: ${JSON.stringify(field.type)}`);
          }
        }
      }
      /**
       * Get the type layout of the given defined type(struct or enum).
       */
      static typeDefLayout({ typeDef, types, name, genericArgs }) {
        return _IdlCoder.typeDefLayoutWithContext({
          typeDef,
          types,
          name,
          genericArgs
        });
      }
      static typeDefLayoutWithContext({ typeDef, types, name, genericArgs, definedTypeStack }) {
        const typeStack = definedTypeStack !== null && definedTypeStack !== void 0 ? definedTypeStack : [typeDef.name];
        switch (typeDef.type.kind) {
          case "struct": {
            const fieldLayouts = (0, idl_js_1.handleDefinedFields)(typeDef.type.fields, () => [], (fields) => fields.map((f) => {
              const genArgs = genericArgs ? _IdlCoder.resolveGenericArgs({
                type: f.type,
                typeDef,
                genericArgs
              }) : genericArgs;
              return _IdlCoder.fieldLayoutWithContext(f, types, genArgs, typeStack);
            }), (fields) => fields.map((f, i) => {
              const genArgs = genericArgs ? _IdlCoder.resolveGenericArgs({
                type: f,
                typeDef,
                genericArgs
              }) : genericArgs;
              return _IdlCoder.fieldLayoutWithContext({ name: i.toString(), type: f }, types, genArgs, typeStack);
            }));
            return borsh.struct(fieldLayouts, name);
          }
          case "enum": {
            const variants = typeDef.type.variants.map((variant) => {
              const fieldLayouts = (0, idl_js_1.handleDefinedFields)(variant.fields, () => [], (fields) => fields.map((f) => {
                const genArgs = genericArgs ? _IdlCoder.resolveGenericArgs({
                  type: f.type,
                  typeDef,
                  genericArgs
                }) : genericArgs;
                return _IdlCoder.fieldLayoutWithContext(f, types, genArgs, typeStack);
              }), (fields) => fields.map((f, i) => {
                const genArgs = genericArgs ? _IdlCoder.resolveGenericArgs({
                  type: f,
                  typeDef,
                  genericArgs
                }) : genericArgs;
                return _IdlCoder.fieldLayoutWithContext({ name: i.toString(), type: f }, types, genArgs, typeStack);
              }));
              return borsh.struct(fieldLayouts, variant.name);
            });
            if (name !== void 0) {
              return borsh.rustEnum(variants).replicate(name);
            }
            return borsh.rustEnum(variants, name);
          }
          case "type": {
            return _IdlCoder.fieldLayoutWithContext({ type: typeDef.type.alias, name }, types, genericArgs, typeStack);
          }
        }
      }
      /**
       * Get the type of the size in bytes. Returns `1` for variable length types.
       */
      static typeSize(ty, idl, genericArgs) {
        return _IdlCoder.typeSizeWithContext(ty, idl, genericArgs);
      }
      static typeSizeWithContext(ty, idl, genericArgs, definedTypeStack = []) {
        var _a;
        switch (ty) {
          case "bool":
            return 1;
          case "u8":
            return 1;
          case "i8":
            return 1;
          case "i16":
            return 2;
          case "u16":
            return 2;
          case "u32":
            return 4;
          case "i32":
            return 4;
          case "f32":
            return 4;
          case "u64":
            return 8;
          case "i64":
            return 8;
          case "f64":
            return 8;
          case "u128":
            return 16;
          case "i128":
            return 16;
          case "u256":
            return 32;
          case "i256":
            return 32;
          case "bytes":
            return 1;
          case "string":
            return 1;
          case "pubkey":
            return 32;
          default:
            if ("option" in ty) {
              return 1 + _IdlCoder.typeSizeWithContext(ty.option, idl, genericArgs, definedTypeStack);
            }
            if ("coption" in ty) {
              return 4 + _IdlCoder.typeSizeWithContext(ty.coption, idl, genericArgs, definedTypeStack);
            }
            if ("vec" in ty) {
              _IdlCoder.assertNonRecursiveType(ty.vec, idl, genericArgs, definedTypeStack);
              return 1;
            }
            if ("array" in ty) {
              let [type, len] = ty.array;
              len = _IdlCoder.resolveArrayLen(len, genericArgs);
              return _IdlCoder.typeSizeWithContext(type, idl, genericArgs, definedTypeStack) * len;
            }
            if ("defined" in ty) {
              const typeName = ty.defined.name;
              if (definedTypeStack.includes(typeName)) {
                throw new error_js_1.IdlError(`Recursive types do not have a static size: ${typeName}`);
              }
              const typeDef = (_a = idl.types) === null || _a === void 0 ? void 0 : _a.find((t) => t.name === typeName);
              if (!typeDef) {
                throw new error_js_1.IdlError(`Type not found: ${JSON.stringify(ty)}`);
              }
              const typeStack = [...definedTypeStack, typeName];
              const typeSize = (type) => {
                const genArgs = genericArgs !== null && genericArgs !== void 0 ? genericArgs : ty.defined.generics;
                const args = genArgs ? _IdlCoder.resolveGenericArgs({
                  type,
                  typeDef,
                  genericArgs: genArgs
                }) : genArgs;
                return _IdlCoder.typeSizeWithContext(type, idl, args, typeStack);
              };
              switch (typeDef.type.kind) {
                case "struct": {
                  return (0, idl_js_1.handleDefinedFields)(typeDef.type.fields, () => [0], (fields) => fields.map((f) => typeSize(f.type)), (fields) => fields.map((f) => typeSize(f))).reduce((acc, size) => acc + size, 0);
                }
                case "enum": {
                  const variantSizes = typeDef.type.variants.map((variant) => {
                    return (0, idl_js_1.handleDefinedFields)(variant.fields, () => [0], (fields) => fields.map((f) => typeSize(f.type)), (fields) => fields.map((f) => typeSize(f))).reduce((acc, size) => acc + size, 0);
                  });
                  return Math.max(...variantSizes) + 1;
                }
                case "type": {
                  return _IdlCoder.typeSizeWithContext(typeDef.type.alias, idl, genericArgs, typeStack);
                }
              }
            }
            if ("generic" in ty) {
              const genericArg = genericArgs === null || genericArgs === void 0 ? void 0 : genericArgs.at(0);
              if ((genericArg === null || genericArg === void 0 ? void 0 : genericArg.kind) !== "type") {
                throw new error_js_1.IdlError(`Invalid generic: ${ty.generic}`);
              }
              return _IdlCoder.typeSizeWithContext(genericArg.type, idl, genericArgs, definedTypeStack);
            }
            throw new Error(`Invalid type ${JSON.stringify(ty)}`);
        }
      }
      static assertNonRecursiveType(ty, idl, genericArgs, definedTypeStack = []) {
        var _a;
        if (typeof ty === "string")
          return;
        if ("option" in ty) {
          return _IdlCoder.assertNonRecursiveType(ty.option, idl, genericArgs, definedTypeStack);
        }
        if ("coption" in ty) {
          return _IdlCoder.assertNonRecursiveType(ty.coption, idl, genericArgs, definedTypeStack);
        }
        if ("vec" in ty) {
          return _IdlCoder.assertNonRecursiveType(ty.vec, idl, genericArgs, definedTypeStack);
        }
        if ("array" in ty) {
          return _IdlCoder.assertNonRecursiveType(ty.array[0], idl, genericArgs, definedTypeStack);
        }
        if ("generic" in ty) {
          const genericArg = genericArgs === null || genericArgs === void 0 ? void 0 : genericArgs.at(0);
          if ((genericArg === null || genericArg === void 0 ? void 0 : genericArg.kind) !== "type") {
            return;
          }
          return _IdlCoder.assertNonRecursiveType(genericArg.type, idl, genericArgs, definedTypeStack);
        }
        if ("defined" in ty) {
          const typeName = ty.defined.name;
          if (definedTypeStack.includes(typeName)) {
            throw new error_js_1.IdlError(`Recursive types do not have a static size: ${typeName}`);
          }
          const typeDef = (_a = idl.types) === null || _a === void 0 ? void 0 : _a.find((t) => t.name === typeName);
          if (!typeDef) {
            throw new error_js_1.IdlError(`Type not found: ${JSON.stringify(ty)}`);
          }
          const typeStack = [...definedTypeStack, typeName];
          const checkType = (type) => {
            const genArgs = genericArgs !== null && genericArgs !== void 0 ? genericArgs : ty.defined.generics;
            const args = genArgs ? _IdlCoder.resolveGenericArgs({
              type,
              typeDef,
              genericArgs: genArgs
            }) : genArgs;
            return _IdlCoder.assertNonRecursiveType(type, idl, args, typeStack);
          };
          switch (typeDef.type.kind) {
            case "struct": {
              return (0, idl_js_1.handleDefinedFields)(typeDef.type.fields, () => void 0, (fields) => fields.forEach((f) => checkType(f.type)), (fields) => fields.forEach((f) => checkType(f)));
            }
            case "enum": {
              typeDef.type.variants.forEach((variant) => (0, idl_js_1.handleDefinedFields)(variant.fields, () => void 0, (fields) => fields.forEach((f) => checkType(f.type)), (fields) => fields.forEach((f) => checkType(f))));
              return;
            }
            case "type": {
              return checkType(typeDef.type.alias);
            }
          }
        }
      }
      /**
       * Resolve the generic array length or return the constant-sized array length.
       */
      static resolveArrayLen(len, genericArgs) {
        if (typeof len === "number")
          return len;
        if (genericArgs) {
          const genericLen = genericArgs.find((g) => g.kind === "const");
          if ((genericLen === null || genericLen === void 0 ? void 0 : genericLen.kind) === "const") {
            len = +genericLen.value;
          }
        }
        if (typeof len !== "number") {
          throw new error_js_1.IdlError("Generic array length did not resolve");
        }
        return len;
      }
      /**
       * Recursively resolve generic arguments i.e. replace all generics with the
       * actual type that they hold based on the initial `genericArgs` given.
       */
      static resolveGenericArgs({ type, typeDef, genericArgs, isDefined }) {
        if (typeof type !== "object")
          return null;
        for (const index in typeDef.generics) {
          const defGeneric = typeDef.generics[index];
          if ("generic" in type && defGeneric.name === type.generic) {
            return [genericArgs[index]];
          }
          if ("option" in type) {
            const args = _IdlCoder.resolveGenericArgs({
              type: type.option,
              typeDef,
              genericArgs,
              isDefined
            });
            if (!args || !isDefined)
              return args;
            if (args[0].kind === "type") {
              return [
                {
                  kind: "type",
                  type: { option: args[0].type }
                }
              ];
            }
          }
          if ("vec" in type) {
            const args = _IdlCoder.resolveGenericArgs({
              type: type.vec,
              typeDef,
              genericArgs,
              isDefined
            });
            if (!args || !isDefined)
              return args;
            if (args[0].kind === "type") {
              return [
                {
                  kind: "type",
                  type: { vec: args[0].type }
                }
              ];
            }
          }
          if ("array" in type) {
            const [elTy, len] = type.array;
            const isGenericLen = typeof len === "object";
            const args = _IdlCoder.resolveGenericArgs({
              type: elTy,
              typeDef,
              genericArgs,
              isDefined
            }) || [];
            if (isGenericLen) {
              const matchingGeneric = typeDef.generics.findIndex((g) => g.name === len.generic);
              if (matchingGeneric !== -1) {
                args.push(genericArgs[matchingGeneric]);
              }
            }
            if (args.length > 0) {
              if (!isDefined)
                return args;
              if (args[0].kind === "type" && args[1].kind === "const") {
                return [
                  {
                    kind: "type",
                    type: { array: [args[0].type, +args[1].value] }
                  }
                ];
              }
            }
            if (isGenericLen && defGeneric.name === len.generic) {
              const arg = genericArgs[index];
              if (!isDefined)
                return [arg];
              return [
                {
                  kind: "type",
                  type: { array: [elTy, +arg.value] }
                }
              ];
            }
            return null;
          }
          if ("defined" in type) {
            if (!type.defined.generics)
              return null;
            return type.defined.generics.flatMap((g) => {
              switch (g.kind) {
                case "type":
                  return _IdlCoder.resolveGenericArgs({
                    type: g.type,
                    typeDef,
                    genericArgs,
                    isDefined: true
                  });
                case "const":
                  return [g];
              }
            }).filter((g) => g !== null);
          }
        }
        return null;
      }
    };
    exports.IdlCoder = IdlCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/instruction.js
var require_instruction = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/instruction.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BorshInstructionCoder = void 0;
    var bs58_1 = __importDefault(require_bs58());
    var buffer_1 = __require("buffer");
    var borsh = __importStar(require_dist2());
    var idl_js_1 = require_idl();
    var idl_js_2 = require_idl2();
    var BorshInstructionCoder = class _BorshInstructionCoder {
      constructor(idl) {
        this.idl = idl;
        const ixLayouts = idl.instructions.map((ix) => {
          const name = ix.name;
          const fieldLayouts = ix.args.map((arg) => idl_js_2.IdlCoder.fieldLayout(arg, idl.types));
          const layout = borsh.struct(fieldLayouts, name);
          return [
            name,
            { discriminator: ix.discriminator, layout, args: ix.args }
          ];
        });
        this.ixLayouts = new Map(ixLayouts);
      }
      /**
       * Encodes a program instruction.
       */
      encode(ixName, ix) {
        const buffer = buffer_1.Buffer.alloc(1e3);
        const encoder = this.ixLayouts.get(ixName);
        if (!encoder) {
          throw new Error(`Unknown method: ${ixName}`);
        }
        if (encoder.args.length > 0) {
          if (ix === null || typeof ix !== "object" || Array.isArray(ix)) {
            const expected = encoder.args.map((a) => a.name).join(", ");
            throw new Error(`Invalid arguments for instruction "${ixName}": expected an object with fields { ${expected} }, got ${ix === null ? "null" : Array.isArray(ix) ? "array" : typeof ix}.`);
          }
        }
        const requiredMissing = encoder.args.filter((arg) => !_BorshInstructionCoder.isOption(arg.type, this.idl.types)).map((arg) => arg.name).filter((name) => !ix.hasOwnProperty(name));
        if (requiredMissing.length > 0) {
          throw new Error(`Invalid arguments for instruction "${ixName}": missing field${requiredMissing.length > 1 ? "s" : ""} ${requiredMissing.map((m) => `\`${m}\``).join(", ")}.`);
        }
        const ixWithDefinedOptions = _BorshInstructionCoder.convertUndefinedOptions(encoder.args, ix, this.idl.types);
        const len = encoder.layout.encode(ixWithDefinedOptions, buffer);
        const data = buffer.slice(0, len);
        return buffer_1.Buffer.concat([buffer_1.Buffer.from(encoder.discriminator), data]);
      }
      static isOption(idlType, types = [], visited = /* @__PURE__ */ new Set()) {
        if (typeof idlType !== "object") {
          return false;
        }
        if ("option" in idlType) {
          return true;
        }
        if ("defined" in idlType) {
          const definedName = idlType.defined.name;
          if (visited.has(definedName)) {
            return false;
          }
          const typeDef = types.find((t) => t.name === definedName);
          if ((typeDef === null || typeDef === void 0 ? void 0 : typeDef.type.kind) !== "type") {
            return false;
          }
          const alias = _BorshInstructionCoder.resolveGenericType(typeDef.type.alias, typeDef, idlType.defined.generics);
          return _BorshInstructionCoder.isOption(alias, types, /* @__PURE__ */ new Set([...visited, definedName]));
        }
        return false;
      }
      static convertUndefinedOptions(args, ix, types = []) {
        const converted = { ...ix };
        args.forEach((arg) => {
          converted[arg.name] = _BorshInstructionCoder.convertUndefinedOption(arg.type, ix[arg.name], types);
        });
        return converted;
      }
      static convertUndefinedOption(idlType, value, types) {
        if (typeof idlType === "string") {
          return value;
        }
        if ("option" in idlType) {
          if (value === void 0) {
            return null;
          }
          if (value === null) {
            return null;
          }
          return _BorshInstructionCoder.convertUndefinedOption(idlType.option, value, types);
        }
        if ("vec" in idlType) {
          return Array.isArray(value) ? value.map((item) => _BorshInstructionCoder.convertUndefinedOption(idlType.vec, item, types)) : value;
        }
        if ("array" in idlType) {
          return Array.isArray(value) ? value.map((item) => _BorshInstructionCoder.convertUndefinedOption(idlType.array[0], item, types)) : value;
        }
        if ("defined" in idlType) {
          const typeDef = types.find((t) => t.name === idlType.defined.name);
          if (!typeDef) {
            return value;
          }
          const genericArgs = idlType.defined.generics;
          return _BorshInstructionCoder.convertUndefinedOptionDefined(typeDef, value, types, genericArgs);
        }
        return value;
      }
      static convertUndefinedOptionDefined(typeDef, value, types, genericArgs) {
        if (typeDef.type.kind === "type") {
          const alias = _BorshInstructionCoder.resolveGenericType(typeDef.type.alias, typeDef, genericArgs);
          return _BorshInstructionCoder.convertUndefinedOption(alias, value, types);
        }
        if (value === null || value === void 0 || typeof value !== "object") {
          return value;
        }
        switch (typeDef.type.kind) {
          case "struct": {
            return (0, idl_js_1.handleDefinedFields)(typeDef.type.fields, () => value, (fields) => {
              const converted = { ...value };
              fields.forEach((field) => {
                const fieldType = _BorshInstructionCoder.resolveGenericType(field.type, typeDef, genericArgs);
                converted[field.name] = _BorshInstructionCoder.convertUndefinedOption(fieldType, value[field.name], types);
              });
              return converted;
            }, (fields) => {
              const converted = Array.isArray(value) ? [...value] : { ...value };
              fields.forEach((field, index) => {
                const fieldType = _BorshInstructionCoder.resolveGenericType(field, typeDef, genericArgs);
                converted[index] = _BorshInstructionCoder.convertUndefinedOption(fieldType, value[index], types);
              });
              return converted;
            });
          }
          case "enum": {
            const variantName = Object.keys(value)[0];
            const variant = typeDef.type.variants.find((v) => v.name === variantName);
            if (!variant) {
              return value;
            }
            return {
              ...value,
              [variantName]: (0, idl_js_1.handleDefinedFields)(variant.fields, () => value[variantName], (fields) => {
                const converted = { ...value[variantName] };
                fields.forEach((field) => {
                  const fieldType = _BorshInstructionCoder.resolveGenericType(field.type, typeDef, genericArgs);
                  converted[field.name] = _BorshInstructionCoder.convertUndefinedOption(fieldType, value[variantName][field.name], types);
                });
                return converted;
              }, (fields) => {
                const converted = Array.isArray(value[variantName]) ? [...value[variantName]] : { ...value[variantName] };
                fields.forEach((field, index) => {
                  const fieldType = _BorshInstructionCoder.resolveGenericType(field, typeDef, genericArgs);
                  converted[index] = _BorshInstructionCoder.convertUndefinedOption(fieldType, value[variantName][index], types);
                });
                return converted;
              })
            };
          }
        }
      }
      static resolveGenericType(idlType, typeDef, genericArgs) {
        var _a, _b;
        if (!genericArgs || typeof idlType !== "object") {
          return idlType;
        }
        if ("generic" in idlType) {
          const genericIndex = (_a = typeDef.generics) === null || _a === void 0 ? void 0 : _a.findIndex((generic) => generic.kind === "type" && generic.name === idlType.generic);
          if (genericIndex === void 0 || genericIndex < 0) {
            return idlType;
          }
          const genericArg = genericArgs[genericIndex];
          return (genericArg === null || genericArg === void 0 ? void 0 : genericArg.kind) === "type" ? genericArg.type : idlType;
        }
        if ("option" in idlType) {
          return {
            option: _BorshInstructionCoder.resolveGenericType(idlType.option, typeDef, genericArgs)
          };
        }
        if ("vec" in idlType) {
          return {
            vec: _BorshInstructionCoder.resolveGenericType(idlType.vec, typeDef, genericArgs)
          };
        }
        if ("array" in idlType) {
          return {
            array: [
              _BorshInstructionCoder.resolveGenericType(idlType.array[0], typeDef, genericArgs),
              idlType.array[1]
            ]
          };
        }
        if ("defined" in idlType) {
          return {
            defined: {
              ...idlType.defined,
              generics: (_b = idlType.defined.generics) === null || _b === void 0 ? void 0 : _b.map((genericArg) => genericArg.kind === "type" ? {
                ...genericArg,
                type: _BorshInstructionCoder.resolveGenericType(genericArg.type, typeDef, genericArgs)
              } : genericArg)
            }
          };
        }
        return idlType;
      }
      /**
       * Decodes a program instruction.
       */
      decode(ix, encoding = "hex") {
        if (typeof ix === "string") {
          ix = encoding === "hex" ? buffer_1.Buffer.from(ix, "hex") : bs58_1.default.decode(ix);
        }
        for (const [name, layout] of this.ixLayouts) {
          const givenDisc = ix.subarray(0, layout.discriminator.length);
          const matches = givenDisc.equals(buffer_1.Buffer.from(layout.discriminator));
          if (matches) {
            return {
              name,
              data: layout.layout.decode(ix.subarray(givenDisc.length))
            };
          }
        }
        return null;
      }
      /**
       * Returns a formatted table of all the fields in the given instruction data.
       */
      format(ix, accountMetas) {
        return InstructionFormatter.format(ix, accountMetas, this.idl);
      }
    };
    exports.BorshInstructionCoder = BorshInstructionCoder;
    var InstructionFormatter = class _InstructionFormatter {
      static format(ix, accountMetas, idl) {
        const idlIx = idl.instructions.find((i) => ix.name === i.name);
        if (!idlIx) {
          console.error("Invalid instruction given");
          return null;
        }
        const args = idlIx.args.map((idlField) => {
          return {
            name: idlField.name,
            type: _InstructionFormatter.formatIdlType(idlField.type),
            data: _InstructionFormatter.formatIdlData(idlField, ix.data[idlField.name], idl.types)
          };
        });
        const flatIdlAccounts = _InstructionFormatter.flattenIdlAccounts(idlIx.accounts);
        const accounts = accountMetas.map((meta, idx) => {
          if (idx < flatIdlAccounts.length) {
            return {
              name: flatIdlAccounts[idx].name,
              ...meta
            };
          } else {
            return {
              name: void 0,
              ...meta
            };
          }
        });
        return {
          args,
          accounts
        };
      }
      static formatIdlType(idlType) {
        if (typeof idlType === "string") {
          return idlType;
        }
        if ("option" in idlType) {
          return `Option<${this.formatIdlType(idlType.option)}>`;
        }
        if ("coption" in idlType) {
          return `COption<${this.formatIdlType(idlType.coption)}>`;
        }
        if ("vec" in idlType) {
          return `Vec<${this.formatIdlType(idlType.vec)}>`;
        }
        if ("array" in idlType) {
          return `Array<${idlType.array[0]}; ${idlType.array[1]}>`;
        }
        if ("defined" in idlType) {
          const name = idlType.defined.name;
          if (idlType.defined.generics) {
            const generics = idlType.defined.generics.map((g) => {
              switch (g.kind) {
                case "type":
                  return _InstructionFormatter.formatIdlType(g.type);
                case "const":
                  return g.value;
              }
            }).join(", ");
            return `${name}<${generics}>`;
          }
          return name;
        }
        throw new Error(`Unknown IDL type: ${idlType}`);
      }
      static formatIdlData(idlField, data, types) {
        if (typeof idlField.type === "string") {
          return data.toString();
        }
        if ("vec" in idlField.type) {
          return "[" + data.map((d) => this.formatIdlData({ name: "", type: idlField.type.vec }, d, types)).join(", ") + "]";
        }
        if ("option" in idlField.type) {
          return data === null ? "null" : this.formatIdlData({ name: "", type: idlField.type.option }, data, types);
        }
        if ("defined" in idlField.type) {
          if (!types) {
            throw new Error("User defined types not provided");
          }
          const definedName = idlField.type.defined.name;
          const typeDef = types.find((t) => t.name === definedName);
          if (!typeDef) {
            throw new Error(`Type not found: ${definedName}`);
          }
          return _InstructionFormatter.formatIdlDataDefined(typeDef, data, types);
        }
        return "unknown";
      }
      static formatIdlDataDefined(typeDef, data, types) {
        switch (typeDef.type.kind) {
          case "struct": {
            return "{ " + (0, idl_js_1.handleDefinedFields)(typeDef.type.fields, () => "", (fields) => {
              return Object.entries(data).map(([key2, val]) => {
                const field = fields.find((f) => f.name === key2);
                if (!field) {
                  throw new Error(`Field not found: ${key2}`);
                }
                return key2 + ": " + _InstructionFormatter.formatIdlData(field, val, types);
              }).join(", ");
            }, (fields) => {
              return Object.entries(data).map(([key2, val]) => {
                return key2 + ": " + _InstructionFormatter.formatIdlData({ name: "", type: fields[key2] }, val, types);
              }).join(", ");
            }) + " }";
          }
          case "enum": {
            const variantName = Object.keys(data)[0];
            const variant = typeDef.type.variants.find((v) => v.name === variantName);
            if (!variant) {
              throw new Error(`Unable to find variant: ${variantName}`);
            }
            const enumValue = data[variantName];
            return (0, idl_js_1.handleDefinedFields)(variant.fields, () => variantName, (fields) => {
              const namedFields = Object.keys(enumValue).map((f) => {
                const fieldData = enumValue[f];
                const idlField = fields.find((v) => v.name === f);
                if (!idlField) {
                  throw new Error(`Field not found: ${f}`);
                }
                return f + ": " + _InstructionFormatter.formatIdlData(idlField, fieldData, types);
              }).join(", ");
              return `${variantName} { ${namedFields} }`;
            }, (fields) => {
              const tupleFields = Object.entries(enumValue).map(([key2, val]) => {
                return key2 + ": " + _InstructionFormatter.formatIdlData({ name: "", type: fields[key2] }, val, types);
              }).join(", ");
              return `${variantName} { ${tupleFields} }`;
            });
          }
          case "type": {
            return _InstructionFormatter.formatIdlType(typeDef.type.alias);
          }
        }
      }
      static flattenIdlAccounts(accounts, prefix) {
        return accounts.map((account) => {
          const accName = sentenceCase(account.name);
          if (account.hasOwnProperty("accounts")) {
            const newPrefix = prefix ? `${prefix} > ${accName}` : accName;
            return _InstructionFormatter.flattenIdlAccounts(account.accounts, newPrefix);
          } else {
            return {
              ...account,
              name: prefix ? `${prefix} > ${accName}` : accName
            };
          }
        }).flat();
      }
    };
    function sentenceCase(field) {
      const result = field.replace(/([A-Z])/g, " $1");
      return result.charAt(0).toUpperCase() + result.slice(1);
    }
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/accounts.js
var require_accounts = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/accounts.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BorshAccountsCoder = void 0;
    var bs58_1 = __importDefault(require_bs58());
    var buffer_1 = __require("buffer");
    var idl_js_1 = require_idl2();
    var BorshAccountsCoder = class {
      constructor(idl) {
        this.idl = idl;
        if (!idl.accounts) {
          this.accountLayouts = /* @__PURE__ */ new Map();
          return;
        }
        const types = idl.types;
        if (!types) {
          throw new Error("Accounts require `idl.types`");
        }
        const layouts = idl.accounts.map((acc) => {
          const typeDef = types.find((ty) => ty.name === acc.name);
          if (!typeDef) {
            throw new Error(`Account not found: ${acc.name}`);
          }
          return [
            acc.name,
            {
              discriminator: acc.discriminator,
              layout: idl_js_1.IdlCoder.typeDefLayout({ typeDef, types })
            }
          ];
        });
        this.accountLayouts = new Map(layouts);
      }
      async encode(accountName, account) {
        const buffer = buffer_1.Buffer.alloc(1e3);
        const layout = this.accountLayouts.get(accountName);
        if (!layout) {
          throw new Error(`Unknown account: ${accountName}`);
        }
        const len = layout.layout.encode(account, buffer);
        const accountData = buffer.slice(0, len);
        const discriminator = this.accountDiscriminator(accountName);
        return buffer_1.Buffer.concat([discriminator, accountData]);
      }
      decode(accountName, data) {
        const discriminator = this.accountDiscriminator(accountName);
        if (discriminator.compare(data.slice(0, discriminator.length))) {
          throw new Error("Invalid account discriminator");
        }
        return this.decodeUnchecked(accountName, data);
      }
      decodeAny(data) {
        for (const [name, layout] of this.accountLayouts) {
          const givenDisc = data.subarray(0, layout.discriminator.length);
          const matches = givenDisc.equals(buffer_1.Buffer.from(layout.discriminator));
          if (matches)
            return this.decodeUnchecked(name, data);
        }
        throw new Error("Account not found");
      }
      decodeUnchecked(accountName, acc) {
        const discriminator = this.accountDiscriminator(accountName);
        const data = acc.subarray(discriminator.length);
        const layout = this.accountLayouts.get(accountName);
        if (!layout) {
          throw new Error(`Unknown account: ${accountName}`);
        }
        return layout.layout.decode(data);
      }
      memcmp(accountName, appendData) {
        const discriminator = this.accountDiscriminator(accountName);
        return {
          offset: 0,
          bytes: bs58_1.default.encode(appendData ? buffer_1.Buffer.concat([discriminator, appendData]) : discriminator)
        };
      }
      size(accountName) {
        return this.accountDiscriminator(accountName).length + idl_js_1.IdlCoder.typeSize({ defined: { name: accountName } }, this.idl);
      }
      /**
       * Get the unique discriminator prepended to all anchor accounts.
       *
       * @param name The name of the account to get the discriminator of.
       */
      accountDiscriminator(name) {
        var _a;
        const account = (_a = this.idl.accounts) === null || _a === void 0 ? void 0 : _a.find((acc) => acc.name === name);
        if (!account) {
          throw new Error(`Account not found: ${name}`);
        }
        return buffer_1.Buffer.from(account.discriminator);
      }
    };
    exports.BorshAccountsCoder = BorshAccountsCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/event.js
var require_event = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/event.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BorshEventCoder = void 0;
    var buffer_1 = __require("buffer");
    var base64 = __importStar(require_base64());
    var idl_js_1 = require_idl2();
    var BorshEventCoder = class {
      constructor(idl) {
        if (!idl.events) {
          this.layouts = /* @__PURE__ */ new Map();
          return;
        }
        const types = idl.types;
        if (!types) {
          throw new Error("Events require `idl.types`");
        }
        const layouts = idl.events.map((ev) => {
          const typeDef = types.find((ty) => ty.name === ev.name);
          if (!typeDef) {
            throw new Error(`Event not found: ${ev.name}`);
          }
          return [
            ev.name,
            {
              discriminator: ev.discriminator,
              layout: idl_js_1.IdlCoder.typeDefLayout({ typeDef, types })
            }
          ];
        });
        this.layouts = new Map(layouts);
      }
      decode(log) {
        let logArr;
        try {
          logArr = base64.decode(log);
        } catch (e) {
          return null;
        }
        for (const [name, layout] of this.layouts) {
          const givenDisc = logArr.subarray(0, layout.discriminator.length);
          const matches = givenDisc.equals(buffer_1.Buffer.from(layout.discriminator));
          if (matches) {
            return {
              name,
              data: layout.layout.decode(logArr.subarray(givenDisc.length))
            };
          }
        }
        return null;
      }
    };
    exports.BorshEventCoder = BorshEventCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/types.js
var require_types = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BorshTypesCoder = void 0;
    var buffer_1 = __require("buffer");
    var idl_js_1 = require_idl2();
    var BorshTypesCoder = class {
      constructor(idl) {
        const types = idl.types;
        if (!types) {
          this.typeLayouts = /* @__PURE__ */ new Map();
          return;
        }
        const layouts = types.filter((ty) => !ty.generics).map((ty) => [
          ty.name,
          idl_js_1.IdlCoder.typeDefLayout({ typeDef: ty, types })
        ]);
        this.typeLayouts = new Map(layouts);
      }
      encode(name, type) {
        const buffer = buffer_1.Buffer.alloc(1e3);
        const layout = this.typeLayouts.get(name);
        if (!layout) {
          throw new Error(`Unknown type: ${name}`);
        }
        const len = layout.encode(type, buffer);
        return buffer.slice(0, len);
      }
      decode(name, data) {
        const layout = this.typeLayouts.get(name);
        if (!layout) {
          throw new Error(`Unknown type: ${name}`);
        }
        return layout.decode(data);
      }
    };
    exports.BorshTypesCoder = BorshTypesCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/index.js
var require_borsh = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/borsh/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BorshCoder = exports.BorshEventCoder = exports.BorshAccountsCoder = exports.BorshInstructionCoder = void 0;
    var instruction_js_1 = require_instruction();
    var accounts_js_1 = require_accounts();
    var event_js_1 = require_event();
    var types_js_1 = require_types();
    var instruction_js_2 = require_instruction();
    Object.defineProperty(exports, "BorshInstructionCoder", { enumerable: true, get: function() {
      return instruction_js_2.BorshInstructionCoder;
    } });
    var accounts_js_2 = require_accounts();
    Object.defineProperty(exports, "BorshAccountsCoder", { enumerable: true, get: function() {
      return accounts_js_2.BorshAccountsCoder;
    } });
    var event_js_2 = require_event();
    Object.defineProperty(exports, "BorshEventCoder", { enumerable: true, get: function() {
      return event_js_2.BorshEventCoder;
    } });
    var BorshCoder2 = class {
      constructor(idl) {
        this.instruction = new instruction_js_1.BorshInstructionCoder(idl);
        this.accounts = new accounts_js_1.BorshAccountsCoder(idl);
        this.events = new event_js_1.BorshEventCoder(idl);
        this.types = new types_js_1.BorshTypesCoder(idl);
      }
    };
    exports.BorshCoder = BorshCoder2;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/instruction.js
var require_instruction2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/instruction.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SystemInstructionCoder = void 0;
    var bn_js_1 = __importDefault(require_bn());
    var BufferLayout = __importStar(require_Layout());
    var SystemInstructionCoder = class {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      constructor(_) {
      }
      encode(ixName, ix) {
        switch (ixName) {
          case "createAccount": {
            return encodeCreateAccount(ix);
          }
          case "assign": {
            return encodeAssign(ix);
          }
          case "transfer": {
            return encodeTransfer(ix);
          }
          case "createAccountWithSeed": {
            return encodeCreateAccountWithSeed(ix);
          }
          case "advanceNonceAccount": {
            return encodeAdvanceNonceAccount(ix);
          }
          case "withdrawNonceAccount": {
            return encodeWithdrawNonceAccount(ix);
          }
          case "initializeNonceAccount": {
            return encodeInitializeNonceAccount(ix);
          }
          case "authorizeNonceAccount": {
            return encodeAuthorizeNonceAccount(ix);
          }
          case "allocate": {
            return encodeAllocate(ix);
          }
          case "allocateWithSeed": {
            return encodeAllocateWithSeed(ix);
          }
          case "assignWithSeed": {
            return encodeAssignWithSeed(ix);
          }
          case "transferWithSeed": {
            return encodeTransferWithSeed(ix);
          }
          default: {
            throw new Error(`Invalid instruction: ${ixName}`);
          }
        }
      }
      encodeState(_ixName, _ix) {
        throw new Error("System does not have state");
      }
    };
    exports.SystemInstructionCoder = SystemInstructionCoder;
    var RustStringLayout = class extends BufferLayout.Layout {
      constructor(property) {
        super(-1, property);
        this.property = property;
        this.layout = BufferLayout.struct([
          BufferLayout.u32("length"),
          BufferLayout.u32("lengthPadding"),
          BufferLayout.blob(BufferLayout.offset(BufferLayout.u32(), -8), "chars")
        ], this.property);
      }
      encode(src, b, offset = 0) {
        if (src === null || src === void 0) {
          return this.layout.span;
        }
        const data = {
          chars: Buffer.from(src, "utf8")
        };
        return this.layout.encode(data, b, offset);
      }
      decode(b, offset = 0) {
        const data = this.layout.decode(b, offset);
        return data["chars"].toString();
      }
      getSpan(b, offset = 0) {
        return BufferLayout.u32().span + BufferLayout.u32().span + new bn_js_1.default(new Uint8Array(b).slice(offset, offset + 4), 10, "le").toNumber();
      }
    };
    function rustStringLayout(property) {
      return new RustStringLayout(property);
    }
    function publicKey(property) {
      return BufferLayout.blob(32, property);
    }
    function encodeCreateAccount({ lamports, space, owner }) {
      return encodeData({
        createAccount: { lamports, space, owner: owner.toBuffer() }
      });
    }
    function encodeAssign({ owner }) {
      return encodeData({
        assign: { owner: owner.toBuffer() }
      });
    }
    function encodeTransfer({ lamports }) {
      return encodeData({
        transfer: { lamports }
      });
    }
    function encodeCreateAccountWithSeed({ base, seed, lamports, space, owner }) {
      return encodeData({
        createAccountWithSeed: {
          base: base.toBuffer(),
          seed,
          lamports,
          space,
          owner: owner.toBuffer()
        }
      }, LAYOUT.getVariant(3).span + seed.length);
    }
    function encodeInitializeNonceAccount({ authorized }) {
      return encodeData({
        initializeNonceAccount: { authorized: authorized.toBuffer() }
      });
    }
    function encodeAdvanceNonceAccount({ authorized }) {
      return encodeData({
        advanceNonceAccount: { authorized: authorized.toBuffer() }
      });
    }
    function encodeWithdrawNonceAccount({ lamports }) {
      return encodeData({
        withdrawNonceAccount: { lamports }
      });
    }
    function encodeAuthorizeNonceAccount({ authorized }) {
      return encodeData({
        authorizeNonceAccount: { authorized: authorized.toBuffer() }
      });
    }
    function encodeAllocate({ space }) {
      return encodeData({
        allocate: { space }
      });
    }
    function encodeAllocateWithSeed({ base, seed, space, owner }) {
      return encodeData({
        allocateWithSeed: {
          base: base.toBuffer(),
          seed,
          space,
          owner: owner.toBuffer()
        }
      }, LAYOUT.getVariant(9).span + seed.length);
    }
    function encodeAssignWithSeed({ base, seed, owner }) {
      return encodeData({
        assignWithSeed: {
          base: base.toBuffer(),
          seed,
          owner: owner.toBuffer()
        }
      }, LAYOUT.getVariant(10).span + seed.length);
    }
    function encodeTransferWithSeed({ lamports, seed, owner }) {
      return encodeData({
        transferWithSeed: {
          lamports,
          seed,
          owner: owner.toBuffer()
        }
      }, LAYOUT.getVariant(11).span + seed.length);
    }
    var LAYOUT = BufferLayout.union(BufferLayout.u32("instruction"));
    LAYOUT.addVariant(0, BufferLayout.struct([
      BufferLayout.ns64("lamports"),
      BufferLayout.ns64("space"),
      publicKey("owner")
    ]), "createAccount");
    LAYOUT.addVariant(1, BufferLayout.struct([publicKey("owner")]), "assign");
    LAYOUT.addVariant(2, BufferLayout.struct([BufferLayout.ns64("lamports")]), "transfer");
    LAYOUT.addVariant(3, BufferLayout.struct([
      publicKey("base"),
      rustStringLayout("seed"),
      BufferLayout.ns64("lamports"),
      BufferLayout.ns64("space"),
      publicKey("owner")
    ]), "createAccountWithSeed");
    LAYOUT.addVariant(4, BufferLayout.struct([publicKey("authorized")]), "advanceNonceAccount");
    LAYOUT.addVariant(5, BufferLayout.struct([BufferLayout.ns64("lamports")]), "withdrawNonceAccount");
    LAYOUT.addVariant(6, BufferLayout.struct([publicKey("authorized")]), "initializeNonceAccount");
    LAYOUT.addVariant(7, BufferLayout.struct([publicKey("authorized")]), "authorizeNonceAccount");
    LAYOUT.addVariant(8, BufferLayout.struct([BufferLayout.ns64("space")]), "allocate");
    LAYOUT.addVariant(9, BufferLayout.struct([
      publicKey("base"),
      rustStringLayout("seed"),
      BufferLayout.ns64("space"),
      publicKey("owner")
    ]), "allocateWithSeed");
    LAYOUT.addVariant(10, BufferLayout.struct([
      publicKey("base"),
      rustStringLayout("seed"),
      publicKey("owner")
    ]), "assignWithSeed");
    LAYOUT.addVariant(11, BufferLayout.struct([
      BufferLayout.ns64("lamports"),
      rustStringLayout("seed"),
      publicKey("owner")
    ]), "transferWithSeed");
    function encodeData(instruction, maxSpan) {
      const b = Buffer.alloc(maxSpan !== null && maxSpan !== void 0 ? maxSpan : instructionMaxSpan);
      const span = LAYOUT.encode(instruction, b);
      if (maxSpan === void 0) {
        return b.slice(0, span);
      }
      return b;
    }
    var instructionMaxSpan = Math.max(...Object.values(LAYOUT.registry).map((r) => r.span));
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/accounts.js
var require_accounts2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/accounts.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SystemAccountsCoder = void 0;
    var BufferLayout = __importStar(require_Layout());
    var web3_js_1 = __require("@solana/web3.js");
    var idl_js_1 = require_idl2();
    var SystemAccountsCoder = class {
      constructor(idl) {
        this.idl = idl;
      }
      async encode(accountName, account) {
        switch (accountName) {
          case "nonce": {
            const buffer = Buffer.alloc(web3_js_1.NONCE_ACCOUNT_LENGTH);
            const len = NONCE_ACCOUNT_LAYOUT.encode(account, buffer);
            return buffer.slice(0, len);
          }
          default: {
            throw new Error(`Invalid account name: ${accountName}`);
          }
        }
      }
      decode(accountName, ix) {
        return this.decodeUnchecked(accountName, ix);
      }
      decodeUnchecked(accountName, ix) {
        switch (accountName) {
          case "nonce": {
            return decodeNonceAccount(ix);
          }
          default: {
            throw new Error(`Invalid account name: ${accountName}`);
          }
        }
      }
      // TODO: this won't use the appendData.
      memcmp(accountName, _appendData) {
        switch (accountName) {
          case "nonce": {
            return {
              dataSize: web3_js_1.NONCE_ACCOUNT_LENGTH
            };
          }
          default: {
            throw new Error(`Invalid account name: ${accountName}`);
          }
        }
      }
      size(accountName) {
        return idl_js_1.IdlCoder.typeSize({ defined: { name: accountName } }, this.idl);
      }
    };
    exports.SystemAccountsCoder = SystemAccountsCoder;
    function decodeNonceAccount(ix) {
      return NONCE_ACCOUNT_LAYOUT.decode(ix);
    }
    var WrappedLayout = class extends BufferLayout.Layout {
      constructor(layout, decoder, encoder, property) {
        super(layout.span, property);
        this.layout = layout;
        this.decoder = decoder;
        this.encoder = encoder;
      }
      decode(b, offset) {
        return this.decoder(this.layout.decode(b, offset));
      }
      encode(src, b, offset) {
        return this.layout.encode(this.encoder(src), b, offset);
      }
      getSpan(b, offset) {
        return this.layout.getSpan(b, offset);
      }
    };
    function publicKey(property) {
      return new WrappedLayout(BufferLayout.blob(32), (b) => new web3_js_1.PublicKey(b), (key2) => key2.toBuffer(), property);
    }
    var NONCE_ACCOUNT_LAYOUT = BufferLayout.struct([
      BufferLayout.u32("version"),
      BufferLayout.u32("state"),
      publicKey("authorizedPubkey"),
      publicKey("nonce"),
      BufferLayout.struct([BufferLayout.nu64("lamportsPerSignature")], "feeCalculator")
    ]);
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/events.js
var require_events = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/events.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SystemEventsCoder = void 0;
    var SystemEventsCoder = class {
      constructor(_idl) {
      }
      decode(_log) {
        throw new Error("System program does not have events");
      }
    };
    exports.SystemEventsCoder = SystemEventsCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/types.js
var require_types2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/types.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SystemTypesCoder = void 0;
    var SystemTypesCoder = class {
      constructor(_idl) {
      }
      encode(_name, _type) {
        throw new Error("System does not have user-defined types");
      }
      decode(_name, _typeData) {
        throw new Error("System does not have user-defined types");
      }
    };
    exports.SystemTypesCoder = SystemTypesCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/index.js
var require_system = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/system/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SystemCoder = void 0;
    var instruction_js_1 = require_instruction2();
    var accounts_js_1 = require_accounts2();
    var events_js_1 = require_events();
    var types_js_1 = require_types2();
    var SystemCoder = class {
      constructor(idl) {
        this.instruction = new instruction_js_1.SystemInstructionCoder(idl);
        this.accounts = new accounts_js_1.SystemAccountsCoder(idl);
        this.events = new events_js_1.SystemEventsCoder(idl);
        this.types = new types_js_1.SystemTypesCoder(idl);
      }
    };
    exports.SystemCoder = SystemCoder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/index.js
var require_coder = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/coder/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    __exportStar(require_borsh(), exports);
    __exportStar(require_system(), exports);
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/cryptoNode.js
var require_cryptoNode = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/cryptoNode.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.crypto = void 0;
    var nc = __require("node:crypto");
    exports.crypto = nc && typeof nc === "object" && "webcrypto" in nc ? nc.webcrypto : nc && typeof nc === "object" && "randomBytes" in nc ? nc : void 0;
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/utils.js
var require_utils = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/utils.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.wrapXOFConstructorWithOpts = exports.wrapConstructorWithOpts = exports.wrapConstructor = exports.Hash = exports.nextTick = exports.swap32IfBE = exports.byteSwapIfBE = exports.swap8IfBE = exports.isLE = void 0;
    exports.isBytes = isBytes;
    exports.anumber = anumber;
    exports.abytes = abytes;
    exports.ahash = ahash;
    exports.aexists = aexists;
    exports.aoutput = aoutput;
    exports.u8 = u8;
    exports.u32 = u32;
    exports.clean = clean;
    exports.createView = createView;
    exports.rotr = rotr;
    exports.rotl = rotl;
    exports.byteSwap = byteSwap;
    exports.byteSwap32 = byteSwap32;
    exports.bytesToHex = bytesToHex;
    exports.hexToBytes = hexToBytes;
    exports.asyncLoop = asyncLoop;
    exports.utf8ToBytes = utf8ToBytes;
    exports.bytesToUtf8 = bytesToUtf8;
    exports.toBytes = toBytes;
    exports.kdfInputToBytes = kdfInputToBytes;
    exports.concatBytes = concatBytes;
    exports.checkOpts = checkOpts;
    exports.createHasher = createHasher;
    exports.createOptHasher = createOptHasher;
    exports.createXOFer = createXOFer;
    exports.randomBytes = randomBytes;
    var crypto_1 = require_cryptoNode();
    function isBytes(a) {
      return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
    }
    function anumber(n) {
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("positive integer expected, got " + n);
    }
    function abytes(b, ...lengths) {
      if (!isBytes(b))
        throw new Error("Uint8Array expected");
      if (lengths.length > 0 && !lengths.includes(b.length))
        throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
    }
    function ahash(h) {
      if (typeof h !== "function" || typeof h.create !== "function")
        throw new Error("Hash should be wrapped by utils.createHasher");
      anumber(h.outputLen);
      anumber(h.blockLen);
    }
    function aexists(instance, checkFinished = true) {
      if (instance.destroyed)
        throw new Error("Hash instance has been destroyed");
      if (checkFinished && instance.finished)
        throw new Error("Hash#digest() has already been called");
    }
    function aoutput(out, instance) {
      abytes(out);
      const min = instance.outputLen;
      if (out.length < min) {
        throw new Error("digestInto() expects output buffer of length at least " + min);
      }
    }
    function u8(arr) {
      return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    }
    function u32(arr) {
      return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
    }
    function clean(...arrays) {
      for (let i = 0; i < arrays.length; i++) {
        arrays[i].fill(0);
      }
    }
    function createView(arr) {
      return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
    }
    function rotr(word, shift) {
      return word << 32 - shift | word >>> shift;
    }
    function rotl(word, shift) {
      return word << shift | word >>> 32 - shift >>> 0;
    }
    exports.isLE = (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
    function byteSwap(word) {
      return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
    }
    exports.swap8IfBE = exports.isLE ? (n) => n : (n) => byteSwap(n);
    exports.byteSwapIfBE = exports.swap8IfBE;
    function byteSwap32(arr) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = byteSwap(arr[i]);
      }
      return arr;
    }
    exports.swap32IfBE = exports.isLE ? (u) => u : byteSwap32;
    var hasHexBuiltin = /* @__PURE__ */ (() => (
      // @ts-ignore
      typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function"
    ))();
    var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
    function bytesToHex(bytes) {
      abytes(bytes);
      if (hasHexBuiltin)
        return bytes.toHex();
      let hex = "";
      for (let i = 0; i < bytes.length; i++) {
        hex += hexes[bytes[i]];
      }
      return hex;
    }
    var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
    function asciiToBase16(ch) {
      if (ch >= asciis._0 && ch <= asciis._9)
        return ch - asciis._0;
      if (ch >= asciis.A && ch <= asciis.F)
        return ch - (asciis.A - 10);
      if (ch >= asciis.a && ch <= asciis.f)
        return ch - (asciis.a - 10);
      return;
    }
    function hexToBytes(hex) {
      if (typeof hex !== "string")
        throw new Error("hex string expected, got " + typeof hex);
      if (hasHexBuiltin)
        return Uint8Array.fromHex(hex);
      const hl = hex.length;
      const al = hl / 2;
      if (hl % 2)
        throw new Error("hex string expected, got unpadded hex of length " + hl);
      const array = new Uint8Array(al);
      for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
        const n1 = asciiToBase16(hex.charCodeAt(hi));
        const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
        if (n1 === void 0 || n2 === void 0) {
          const char = hex[hi] + hex[hi + 1];
          throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
        }
        array[ai] = n1 * 16 + n2;
      }
      return array;
    }
    var nextTick = async () => {
    };
    exports.nextTick = nextTick;
    async function asyncLoop(iters, tick, cb) {
      let ts = Date.now();
      for (let i = 0; i < iters; i++) {
        cb(i);
        const diff = Date.now() - ts;
        if (diff >= 0 && diff < tick)
          continue;
        await (0, exports.nextTick)();
        ts += diff;
      }
    }
    function utf8ToBytes(str) {
      if (typeof str !== "string")
        throw new Error("string expected");
      return new Uint8Array(new TextEncoder().encode(str));
    }
    function bytesToUtf8(bytes) {
      return new TextDecoder().decode(bytes);
    }
    function toBytes(data) {
      if (typeof data === "string")
        data = utf8ToBytes(data);
      abytes(data);
      return data;
    }
    function kdfInputToBytes(data) {
      if (typeof data === "string")
        data = utf8ToBytes(data);
      abytes(data);
      return data;
    }
    function concatBytes(...arrays) {
      let sum = 0;
      for (let i = 0; i < arrays.length; i++) {
        const a = arrays[i];
        abytes(a);
        sum += a.length;
      }
      const res = new Uint8Array(sum);
      for (let i = 0, pad = 0; i < arrays.length; i++) {
        const a = arrays[i];
        res.set(a, pad);
        pad += a.length;
      }
      return res;
    }
    function checkOpts(defaults, opts) {
      if (opts !== void 0 && {}.toString.call(opts) !== "[object Object]")
        throw new Error("options should be object or undefined");
      const merged = Object.assign(defaults, opts);
      return merged;
    }
    var Hash = class {
    };
    exports.Hash = Hash;
    function createHasher(hashCons) {
      const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
      const tmp = hashCons();
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = () => hashCons();
      return hashC;
    }
    function createOptHasher(hashCons) {
      const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
      const tmp = hashCons({});
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = (opts) => hashCons(opts);
      return hashC;
    }
    function createXOFer(hashCons) {
      const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
      const tmp = hashCons({});
      hashC.outputLen = tmp.outputLen;
      hashC.blockLen = tmp.blockLen;
      hashC.create = (opts) => hashCons(opts);
      return hashC;
    }
    exports.wrapConstructor = createHasher;
    exports.wrapConstructorWithOpts = createOptHasher;
    exports.wrapXOFConstructorWithOpts = createXOFer;
    function randomBytes(bytesLength = 32) {
      if (crypto_1.crypto && typeof crypto_1.crypto.getRandomValues === "function") {
        return crypto_1.crypto.getRandomValues(new Uint8Array(bytesLength));
      }
      if (crypto_1.crypto && typeof crypto_1.crypto.randomBytes === "function") {
        return Uint8Array.from(crypto_1.crypto.randomBytes(bytesLength));
      }
      throw new Error("crypto.getRandomValues must be defined");
    }
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/_md.js
var require_md = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/_md.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SHA512_IV = exports.SHA384_IV = exports.SHA224_IV = exports.SHA256_IV = exports.HashMD = void 0;
    exports.setBigUint64 = setBigUint64;
    exports.Chi = Chi;
    exports.Maj = Maj;
    var utils_ts_1 = require_utils();
    function setBigUint64(view, byteOffset, value, isLE) {
      if (typeof view.setBigUint64 === "function")
        return view.setBigUint64(byteOffset, value, isLE);
      const _32n = BigInt(32);
      const _u32_max = BigInt(4294967295);
      const wh = Number(value >> _32n & _u32_max);
      const wl = Number(value & _u32_max);
      const h = isLE ? 4 : 0;
      const l = isLE ? 0 : 4;
      view.setUint32(byteOffset + h, wh, isLE);
      view.setUint32(byteOffset + l, wl, isLE);
    }
    function Chi(a, b, c) {
      return a & b ^ ~a & c;
    }
    function Maj(a, b, c) {
      return a & b ^ a & c ^ b & c;
    }
    var HashMD = class extends utils_ts_1.Hash {
      constructor(blockLen, outputLen, padOffset, isLE) {
        super();
        this.finished = false;
        this.length = 0;
        this.pos = 0;
        this.destroyed = false;
        this.blockLen = blockLen;
        this.outputLen = outputLen;
        this.padOffset = padOffset;
        this.isLE = isLE;
        this.buffer = new Uint8Array(blockLen);
        this.view = (0, utils_ts_1.createView)(this.buffer);
      }
      update(data) {
        (0, utils_ts_1.aexists)(this);
        data = (0, utils_ts_1.toBytes)(data);
        (0, utils_ts_1.abytes)(data);
        const { view, buffer, blockLen } = this;
        const len = data.length;
        for (let pos = 0; pos < len; ) {
          const take = Math.min(blockLen - this.pos, len - pos);
          if (take === blockLen) {
            const dataView = (0, utils_ts_1.createView)(data);
            for (; blockLen <= len - pos; pos += blockLen)
              this.process(dataView, pos);
            continue;
          }
          buffer.set(data.subarray(pos, pos + take), this.pos);
          this.pos += take;
          pos += take;
          if (this.pos === blockLen) {
            this.process(view, 0);
            this.pos = 0;
          }
        }
        this.length += data.length;
        this.roundClean();
        return this;
      }
      digestInto(out) {
        (0, utils_ts_1.aexists)(this);
        (0, utils_ts_1.aoutput)(out, this);
        this.finished = true;
        const { buffer, view, blockLen, isLE } = this;
        let { pos } = this;
        buffer[pos++] = 128;
        (0, utils_ts_1.clean)(this.buffer.subarray(pos));
        if (this.padOffset > blockLen - pos) {
          this.process(view, 0);
          pos = 0;
        }
        for (let i = pos; i < blockLen; i++)
          buffer[i] = 0;
        setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE);
        this.process(view, 0);
        const oview = (0, utils_ts_1.createView)(out);
        const len = this.outputLen;
        if (len % 4)
          throw new Error("_sha2: outputLen should be aligned to 32bit");
        const outLen = len / 4;
        const state = this.get();
        if (outLen > state.length)
          throw new Error("_sha2: outputLen bigger than state");
        for (let i = 0; i < outLen; i++)
          oview.setUint32(4 * i, state[i], isLE);
      }
      digest() {
        const { buffer, outputLen } = this;
        this.digestInto(buffer);
        const res = buffer.slice(0, outputLen);
        this.destroy();
        return res;
      }
      _cloneInto(to) {
        to || (to = new this.constructor());
        to.set(...this.get());
        const { blockLen, buffer, length, finished, destroyed, pos } = this;
        to.destroyed = destroyed;
        to.finished = finished;
        to.length = length;
        to.pos = pos;
        if (length % blockLen)
          to.buffer.set(buffer);
        return to;
      }
      clone() {
        return this._cloneInto();
      }
    };
    exports.HashMD = HashMD;
    exports.SHA256_IV = Uint32Array.from([
      1779033703,
      3144134277,
      1013904242,
      2773480762,
      1359893119,
      2600822924,
      528734635,
      1541459225
    ]);
    exports.SHA224_IV = Uint32Array.from([
      3238371032,
      914150663,
      812702999,
      4144912697,
      4290775857,
      1750603025,
      1694076839,
      3204075428
    ]);
    exports.SHA384_IV = Uint32Array.from([
      3418070365,
      3238371032,
      1654270250,
      914150663,
      2438529370,
      812702999,
      355462360,
      4144912697,
      1731405415,
      4290775857,
      2394180231,
      1750603025,
      3675008525,
      1694076839,
      1203062813,
      3204075428
    ]);
    exports.SHA512_IV = Uint32Array.from([
      1779033703,
      4089235720,
      3144134277,
      2227873595,
      1013904242,
      4271175723,
      2773480762,
      1595750129,
      1359893119,
      2917565137,
      2600822924,
      725511199,
      528734635,
      4215389547,
      1541459225,
      327033209
    ]);
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/_u64.js
var require_u64 = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/_u64.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.toBig = exports.shrSL = exports.shrSH = exports.rotrSL = exports.rotrSH = exports.rotrBL = exports.rotrBH = exports.rotr32L = exports.rotr32H = exports.rotlSL = exports.rotlSH = exports.rotlBL = exports.rotlBH = exports.add5L = exports.add5H = exports.add4L = exports.add4H = exports.add3L = exports.add3H = void 0;
    exports.add = add;
    exports.fromBig = fromBig;
    exports.split = split;
    var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
    var _32n = /* @__PURE__ */ BigInt(32);
    function fromBig(n, le = false) {
      if (le)
        return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
      return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
    }
    function split(lst, le = false) {
      const len = lst.length;
      let Ah = new Uint32Array(len);
      let Al = new Uint32Array(len);
      for (let i = 0; i < len; i++) {
        const { h, l } = fromBig(lst[i], le);
        [Ah[i], Al[i]] = [h, l];
      }
      return [Ah, Al];
    }
    var toBig = (h, l) => BigInt(h >>> 0) << _32n | BigInt(l >>> 0);
    exports.toBig = toBig;
    var shrSH = (h, _l, s) => h >>> s;
    exports.shrSH = shrSH;
    var shrSL = (h, l, s) => h << 32 - s | l >>> s;
    exports.shrSL = shrSL;
    var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
    exports.rotrSH = rotrSH;
    var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
    exports.rotrSL = rotrSL;
    var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
    exports.rotrBH = rotrBH;
    var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
    exports.rotrBL = rotrBL;
    var rotr32H = (_h, l) => l;
    exports.rotr32H = rotr32H;
    var rotr32L = (h, _l) => h;
    exports.rotr32L = rotr32L;
    var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
    exports.rotlSH = rotlSH;
    var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
    exports.rotlSL = rotlSL;
    var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
    exports.rotlBH = rotlBH;
    var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
    exports.rotlBL = rotlBL;
    function add(Ah, Al, Bh, Bl) {
      const l = (Al >>> 0) + (Bl >>> 0);
      return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
    }
    var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
    exports.add3L = add3L;
    var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
    exports.add3H = add3H;
    var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
    exports.add4L = add4L;
    var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
    exports.add4H = add4H;
    var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
    exports.add5L = add5L;
    var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
    exports.add5H = add5H;
    var u64 = {
      fromBig,
      split,
      toBig,
      shrSH,
      shrSL,
      rotrSH,
      rotrSL,
      rotrBH,
      rotrBL,
      rotr32H,
      rotr32L,
      rotlSH,
      rotlSL,
      rotlBH,
      rotlBL,
      add,
      add3L,
      add3H,
      add4L,
      add4H,
      add5H,
      add5L
    };
    exports.default = u64;
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/sha2.js
var require_sha2 = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/sha2.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.sha512_224 = exports.sha512_256 = exports.sha384 = exports.sha512 = exports.sha224 = exports.sha256 = exports.SHA512_256 = exports.SHA512_224 = exports.SHA384 = exports.SHA512 = exports.SHA224 = exports.SHA256 = void 0;
    var _md_ts_1 = require_md();
    var u64 = require_u64();
    var utils_ts_1 = require_utils();
    var SHA256_K = /* @__PURE__ */ Uint32Array.from([
      1116352408,
      1899447441,
      3049323471,
      3921009573,
      961987163,
      1508970993,
      2453635748,
      2870763221,
      3624381080,
      310598401,
      607225278,
      1426881987,
      1925078388,
      2162078206,
      2614888103,
      3248222580,
      3835390401,
      4022224774,
      264347078,
      604807628,
      770255983,
      1249150122,
      1555081692,
      1996064986,
      2554220882,
      2821834349,
      2952996808,
      3210313671,
      3336571891,
      3584528711,
      113926993,
      338241895,
      666307205,
      773529912,
      1294757372,
      1396182291,
      1695183700,
      1986661051,
      2177026350,
      2456956037,
      2730485921,
      2820302411,
      3259730800,
      3345764771,
      3516065817,
      3600352804,
      4094571909,
      275423344,
      430227734,
      506948616,
      659060556,
      883997877,
      958139571,
      1322822218,
      1537002063,
      1747873779,
      1955562222,
      2024104815,
      2227730452,
      2361852424,
      2428436474,
      2756734187,
      3204031479,
      3329325298
    ]);
    var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
    var SHA256 = class extends _md_ts_1.HashMD {
      constructor(outputLen = 32) {
        super(64, outputLen, 8, false);
        this.A = _md_ts_1.SHA256_IV[0] | 0;
        this.B = _md_ts_1.SHA256_IV[1] | 0;
        this.C = _md_ts_1.SHA256_IV[2] | 0;
        this.D = _md_ts_1.SHA256_IV[3] | 0;
        this.E = _md_ts_1.SHA256_IV[4] | 0;
        this.F = _md_ts_1.SHA256_IV[5] | 0;
        this.G = _md_ts_1.SHA256_IV[6] | 0;
        this.H = _md_ts_1.SHA256_IV[7] | 0;
      }
      get() {
        const { A, B, C, D, E, F, G, H } = this;
        return [A, B, C, D, E, F, G, H];
      }
      // prettier-ignore
      set(A, B, C, D, E, F, G, H) {
        this.A = A | 0;
        this.B = B | 0;
        this.C = C | 0;
        this.D = D | 0;
        this.E = E | 0;
        this.F = F | 0;
        this.G = G | 0;
        this.H = H | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4)
          SHA256_W[i] = view.getUint32(offset, false);
        for (let i = 16; i < 64; i++) {
          const W15 = SHA256_W[i - 15];
          const W2 = SHA256_W[i - 2];
          const s0 = (0, utils_ts_1.rotr)(W15, 7) ^ (0, utils_ts_1.rotr)(W15, 18) ^ W15 >>> 3;
          const s1 = (0, utils_ts_1.rotr)(W2, 17) ^ (0, utils_ts_1.rotr)(W2, 19) ^ W2 >>> 10;
          SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
        }
        let { A, B, C, D, E, F, G, H } = this;
        for (let i = 0; i < 64; i++) {
          const sigma1 = (0, utils_ts_1.rotr)(E, 6) ^ (0, utils_ts_1.rotr)(E, 11) ^ (0, utils_ts_1.rotr)(E, 25);
          const T1 = H + sigma1 + (0, _md_ts_1.Chi)(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
          const sigma0 = (0, utils_ts_1.rotr)(A, 2) ^ (0, utils_ts_1.rotr)(A, 13) ^ (0, utils_ts_1.rotr)(A, 22);
          const T2 = sigma0 + (0, _md_ts_1.Maj)(A, B, C) | 0;
          H = G;
          G = F;
          F = E;
          E = D + T1 | 0;
          D = C;
          C = B;
          B = A;
          A = T1 + T2 | 0;
        }
        A = A + this.A | 0;
        B = B + this.B | 0;
        C = C + this.C | 0;
        D = D + this.D | 0;
        E = E + this.E | 0;
        F = F + this.F | 0;
        G = G + this.G | 0;
        H = H + this.H | 0;
        this.set(A, B, C, D, E, F, G, H);
      }
      roundClean() {
        (0, utils_ts_1.clean)(SHA256_W);
      }
      destroy() {
        this.set(0, 0, 0, 0, 0, 0, 0, 0);
        (0, utils_ts_1.clean)(this.buffer);
      }
    };
    exports.SHA256 = SHA256;
    var SHA224 = class extends SHA256 {
      constructor() {
        super(28);
        this.A = _md_ts_1.SHA224_IV[0] | 0;
        this.B = _md_ts_1.SHA224_IV[1] | 0;
        this.C = _md_ts_1.SHA224_IV[2] | 0;
        this.D = _md_ts_1.SHA224_IV[3] | 0;
        this.E = _md_ts_1.SHA224_IV[4] | 0;
        this.F = _md_ts_1.SHA224_IV[5] | 0;
        this.G = _md_ts_1.SHA224_IV[6] | 0;
        this.H = _md_ts_1.SHA224_IV[7] | 0;
      }
    };
    exports.SHA224 = SHA224;
    var K512 = /* @__PURE__ */ (() => u64.split([
      "0x428a2f98d728ae22",
      "0x7137449123ef65cd",
      "0xb5c0fbcfec4d3b2f",
      "0xe9b5dba58189dbbc",
      "0x3956c25bf348b538",
      "0x59f111f1b605d019",
      "0x923f82a4af194f9b",
      "0xab1c5ed5da6d8118",
      "0xd807aa98a3030242",
      "0x12835b0145706fbe",
      "0x243185be4ee4b28c",
      "0x550c7dc3d5ffb4e2",
      "0x72be5d74f27b896f",
      "0x80deb1fe3b1696b1",
      "0x9bdc06a725c71235",
      "0xc19bf174cf692694",
      "0xe49b69c19ef14ad2",
      "0xefbe4786384f25e3",
      "0x0fc19dc68b8cd5b5",
      "0x240ca1cc77ac9c65",
      "0x2de92c6f592b0275",
      "0x4a7484aa6ea6e483",
      "0x5cb0a9dcbd41fbd4",
      "0x76f988da831153b5",
      "0x983e5152ee66dfab",
      "0xa831c66d2db43210",
      "0xb00327c898fb213f",
      "0xbf597fc7beef0ee4",
      "0xc6e00bf33da88fc2",
      "0xd5a79147930aa725",
      "0x06ca6351e003826f",
      "0x142929670a0e6e70",
      "0x27b70a8546d22ffc",
      "0x2e1b21385c26c926",
      "0x4d2c6dfc5ac42aed",
      "0x53380d139d95b3df",
      "0x650a73548baf63de",
      "0x766a0abb3c77b2a8",
      "0x81c2c92e47edaee6",
      "0x92722c851482353b",
      "0xa2bfe8a14cf10364",
      "0xa81a664bbc423001",
      "0xc24b8b70d0f89791",
      "0xc76c51a30654be30",
      "0xd192e819d6ef5218",
      "0xd69906245565a910",
      "0xf40e35855771202a",
      "0x106aa07032bbd1b8",
      "0x19a4c116b8d2d0c8",
      "0x1e376c085141ab53",
      "0x2748774cdf8eeb99",
      "0x34b0bcb5e19b48a8",
      "0x391c0cb3c5c95a63",
      "0x4ed8aa4ae3418acb",
      "0x5b9cca4f7763e373",
      "0x682e6ff3d6b2b8a3",
      "0x748f82ee5defb2fc",
      "0x78a5636f43172f60",
      "0x84c87814a1f0ab72",
      "0x8cc702081a6439ec",
      "0x90befffa23631e28",
      "0xa4506cebde82bde9",
      "0xbef9a3f7b2c67915",
      "0xc67178f2e372532b",
      "0xca273eceea26619c",
      "0xd186b8c721c0c207",
      "0xeada7dd6cde0eb1e",
      "0xf57d4f7fee6ed178",
      "0x06f067aa72176fba",
      "0x0a637dc5a2c898a6",
      "0x113f9804bef90dae",
      "0x1b710b35131c471b",
      "0x28db77f523047d84",
      "0x32caab7b40c72493",
      "0x3c9ebe0a15c9bebc",
      "0x431d67c49c100d4c",
      "0x4cc5d4becb3e42b6",
      "0x597f299cfc657e2a",
      "0x5fcb6fab3ad6faec",
      "0x6c44198c4a475817"
    ].map((n) => BigInt(n))))();
    var SHA512_Kh = /* @__PURE__ */ (() => K512[0])();
    var SHA512_Kl = /* @__PURE__ */ (() => K512[1])();
    var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
    var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
    var SHA512 = class extends _md_ts_1.HashMD {
      constructor(outputLen = 64) {
        super(128, outputLen, 16, false);
        this.Ah = _md_ts_1.SHA512_IV[0] | 0;
        this.Al = _md_ts_1.SHA512_IV[1] | 0;
        this.Bh = _md_ts_1.SHA512_IV[2] | 0;
        this.Bl = _md_ts_1.SHA512_IV[3] | 0;
        this.Ch = _md_ts_1.SHA512_IV[4] | 0;
        this.Cl = _md_ts_1.SHA512_IV[5] | 0;
        this.Dh = _md_ts_1.SHA512_IV[6] | 0;
        this.Dl = _md_ts_1.SHA512_IV[7] | 0;
        this.Eh = _md_ts_1.SHA512_IV[8] | 0;
        this.El = _md_ts_1.SHA512_IV[9] | 0;
        this.Fh = _md_ts_1.SHA512_IV[10] | 0;
        this.Fl = _md_ts_1.SHA512_IV[11] | 0;
        this.Gh = _md_ts_1.SHA512_IV[12] | 0;
        this.Gl = _md_ts_1.SHA512_IV[13] | 0;
        this.Hh = _md_ts_1.SHA512_IV[14] | 0;
        this.Hl = _md_ts_1.SHA512_IV[15] | 0;
      }
      // prettier-ignore
      get() {
        const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
      }
      // prettier-ignore
      set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
        this.Ah = Ah | 0;
        this.Al = Al | 0;
        this.Bh = Bh | 0;
        this.Bl = Bl | 0;
        this.Ch = Ch | 0;
        this.Cl = Cl | 0;
        this.Dh = Dh | 0;
        this.Dl = Dl | 0;
        this.Eh = Eh | 0;
        this.El = El | 0;
        this.Fh = Fh | 0;
        this.Fl = Fl | 0;
        this.Gh = Gh | 0;
        this.Gl = Gl | 0;
        this.Hh = Hh | 0;
        this.Hl = Hl | 0;
      }
      process(view, offset) {
        for (let i = 0; i < 16; i++, offset += 4) {
          SHA512_W_H[i] = view.getUint32(offset);
          SHA512_W_L[i] = view.getUint32(offset += 4);
        }
        for (let i = 16; i < 80; i++) {
          const W15h = SHA512_W_H[i - 15] | 0;
          const W15l = SHA512_W_L[i - 15] | 0;
          const s0h = u64.rotrSH(W15h, W15l, 1) ^ u64.rotrSH(W15h, W15l, 8) ^ u64.shrSH(W15h, W15l, 7);
          const s0l = u64.rotrSL(W15h, W15l, 1) ^ u64.rotrSL(W15h, W15l, 8) ^ u64.shrSL(W15h, W15l, 7);
          const W2h = SHA512_W_H[i - 2] | 0;
          const W2l = SHA512_W_L[i - 2] | 0;
          const s1h = u64.rotrSH(W2h, W2l, 19) ^ u64.rotrBH(W2h, W2l, 61) ^ u64.shrSH(W2h, W2l, 6);
          const s1l = u64.rotrSL(W2h, W2l, 19) ^ u64.rotrBL(W2h, W2l, 61) ^ u64.shrSL(W2h, W2l, 6);
          const SUMl = u64.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
          const SUMh = u64.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
          SHA512_W_H[i] = SUMh | 0;
          SHA512_W_L[i] = SUMl | 0;
        }
        let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
        for (let i = 0; i < 80; i++) {
          const sigma1h = u64.rotrSH(Eh, El, 14) ^ u64.rotrSH(Eh, El, 18) ^ u64.rotrBH(Eh, El, 41);
          const sigma1l = u64.rotrSL(Eh, El, 14) ^ u64.rotrSL(Eh, El, 18) ^ u64.rotrBL(Eh, El, 41);
          const CHIh = Eh & Fh ^ ~Eh & Gh;
          const CHIl = El & Fl ^ ~El & Gl;
          const T1ll = u64.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
          const T1h = u64.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
          const T1l = T1ll | 0;
          const sigma0h = u64.rotrSH(Ah, Al, 28) ^ u64.rotrBH(Ah, Al, 34) ^ u64.rotrBH(Ah, Al, 39);
          const sigma0l = u64.rotrSL(Ah, Al, 28) ^ u64.rotrBL(Ah, Al, 34) ^ u64.rotrBL(Ah, Al, 39);
          const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
          const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
          Hh = Gh | 0;
          Hl = Gl | 0;
          Gh = Fh | 0;
          Gl = Fl | 0;
          Fh = Eh | 0;
          Fl = El | 0;
          ({ h: Eh, l: El } = u64.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
          Dh = Ch | 0;
          Dl = Cl | 0;
          Ch = Bh | 0;
          Cl = Bl | 0;
          Bh = Ah | 0;
          Bl = Al | 0;
          const All = u64.add3L(T1l, sigma0l, MAJl);
          Ah = u64.add3H(All, T1h, sigma0h, MAJh);
          Al = All | 0;
        }
        ({ h: Ah, l: Al } = u64.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
        ({ h: Bh, l: Bl } = u64.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
        ({ h: Ch, l: Cl } = u64.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
        ({ h: Dh, l: Dl } = u64.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
        ({ h: Eh, l: El } = u64.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
        ({ h: Fh, l: Fl } = u64.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
        ({ h: Gh, l: Gl } = u64.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
        ({ h: Hh, l: Hl } = u64.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
        this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
      }
      roundClean() {
        (0, utils_ts_1.clean)(SHA512_W_H, SHA512_W_L);
      }
      destroy() {
        (0, utils_ts_1.clean)(this.buffer);
        this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      }
    };
    exports.SHA512 = SHA512;
    var SHA384 = class extends SHA512 {
      constructor() {
        super(48);
        this.Ah = _md_ts_1.SHA384_IV[0] | 0;
        this.Al = _md_ts_1.SHA384_IV[1] | 0;
        this.Bh = _md_ts_1.SHA384_IV[2] | 0;
        this.Bl = _md_ts_1.SHA384_IV[3] | 0;
        this.Ch = _md_ts_1.SHA384_IV[4] | 0;
        this.Cl = _md_ts_1.SHA384_IV[5] | 0;
        this.Dh = _md_ts_1.SHA384_IV[6] | 0;
        this.Dl = _md_ts_1.SHA384_IV[7] | 0;
        this.Eh = _md_ts_1.SHA384_IV[8] | 0;
        this.El = _md_ts_1.SHA384_IV[9] | 0;
        this.Fh = _md_ts_1.SHA384_IV[10] | 0;
        this.Fl = _md_ts_1.SHA384_IV[11] | 0;
        this.Gh = _md_ts_1.SHA384_IV[12] | 0;
        this.Gl = _md_ts_1.SHA384_IV[13] | 0;
        this.Hh = _md_ts_1.SHA384_IV[14] | 0;
        this.Hl = _md_ts_1.SHA384_IV[15] | 0;
      }
    };
    exports.SHA384 = SHA384;
    var T224_IV = /* @__PURE__ */ Uint32Array.from([
      2352822216,
      424955298,
      1944164710,
      2312950998,
      502970286,
      855612546,
      1738396948,
      1479516111,
      258812777,
      2077511080,
      2011393907,
      79989058,
      1067287976,
      1780299464,
      286451373,
      2446758561
    ]);
    var T256_IV = /* @__PURE__ */ Uint32Array.from([
      573645204,
      4230739756,
      2673172387,
      3360449730,
      596883563,
      1867755857,
      2520282905,
      1497426621,
      2519219938,
      2827943907,
      3193839141,
      1401305490,
      721525244,
      746961066,
      246885852,
      2177182882
    ]);
    var SHA512_224 = class extends SHA512 {
      constructor() {
        super(28);
        this.Ah = T224_IV[0] | 0;
        this.Al = T224_IV[1] | 0;
        this.Bh = T224_IV[2] | 0;
        this.Bl = T224_IV[3] | 0;
        this.Ch = T224_IV[4] | 0;
        this.Cl = T224_IV[5] | 0;
        this.Dh = T224_IV[6] | 0;
        this.Dl = T224_IV[7] | 0;
        this.Eh = T224_IV[8] | 0;
        this.El = T224_IV[9] | 0;
        this.Fh = T224_IV[10] | 0;
        this.Fl = T224_IV[11] | 0;
        this.Gh = T224_IV[12] | 0;
        this.Gl = T224_IV[13] | 0;
        this.Hh = T224_IV[14] | 0;
        this.Hl = T224_IV[15] | 0;
      }
    };
    exports.SHA512_224 = SHA512_224;
    var SHA512_256 = class extends SHA512 {
      constructor() {
        super(32);
        this.Ah = T256_IV[0] | 0;
        this.Al = T256_IV[1] | 0;
        this.Bh = T256_IV[2] | 0;
        this.Bl = T256_IV[3] | 0;
        this.Ch = T256_IV[4] | 0;
        this.Cl = T256_IV[5] | 0;
        this.Dh = T256_IV[6] | 0;
        this.Dl = T256_IV[7] | 0;
        this.Eh = T256_IV[8] | 0;
        this.El = T256_IV[9] | 0;
        this.Fh = T256_IV[10] | 0;
        this.Fl = T256_IV[11] | 0;
        this.Gh = T256_IV[12] | 0;
        this.Gl = T256_IV[13] | 0;
        this.Hh = T256_IV[14] | 0;
        this.Hl = T256_IV[15] | 0;
      }
    };
    exports.SHA512_256 = SHA512_256;
    exports.sha256 = (0, utils_ts_1.createHasher)(() => new SHA256());
    exports.sha224 = (0, utils_ts_1.createHasher)(() => new SHA224());
    exports.sha512 = (0, utils_ts_1.createHasher)(() => new SHA512());
    exports.sha384 = (0, utils_ts_1.createHasher)(() => new SHA384());
    exports.sha512_256 = (0, utils_ts_1.createHasher)(() => new SHA512_256());
    exports.sha512_224 = (0, utils_ts_1.createHasher)(() => new SHA512_224());
  }
});

// sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/sha256.js
var require_sha256 = __commonJS({
  "sdk/node_modules/.pnpm/@noble+hashes@1.8.0/node_modules/@noble/hashes/sha256.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.sha224 = exports.SHA224 = exports.sha256 = exports.SHA256 = void 0;
    var sha2_ts_1 = require_sha2();
    exports.SHA256 = sha2_ts_1.SHA256;
    exports.sha256 = sha2_ts_1.sha256;
    exports.SHA224 = sha2_ts_1.SHA224;
    exports.sha224 = sha2_ts_1.sha224;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/sha256.js
var require_sha2562 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/sha256.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.hash = void 0;
    var sha256_1 = require_sha256();
    var utils_1 = require_utils();
    function hash(data) {
      return (0, utils_1.bytesToHex)((0, sha256_1.sha256)(data));
    }
    exports.hash = hash;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/pubkey.js
var require_pubkey = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/pubkey.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.createWithSeedSync = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var sha256_1 = require_sha256();
    function createWithSeedSync(fromPublicKey, seed, programId) {
      const buffer = Buffer.concat([
        fromPublicKey.toBuffer(),
        Buffer.from(seed),
        programId.toBuffer()
      ]);
      return new web3_js_1.PublicKey((0, sha256_1.sha256)(buffer));
    }
    exports.createWithSeedSync = createWithSeedSync;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/token.js
var require_token = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/token.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.associatedAddress = exports.ASSOCIATED_PROGRAM_ID = exports.TOKEN_PROGRAM_ID = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    exports.TOKEN_PROGRAM_ID = new web3_js_1.PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    exports.ASSOCIATED_PROGRAM_ID = new web3_js_1.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    function associatedAddress({ mint, owner }) {
      return web3_js_1.PublicKey.findProgramAddressSync([owner.toBuffer(), exports.TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], exports.ASSOCIATED_PROGRAM_ID)[0];
    }
    exports.associatedAddress = associatedAddress;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/registry.js
var require_registry = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/registry.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.decodeUpgradeableLoaderState = exports.fetchData = exports.verifiedBuild = void 0;
    var borsh = __importStar(require_dist2());
    var OSEC_REGISTRY_URL = "https://verify.osec.io";
    async function verifiedBuild(programId) {
      try {
        const resp = await fetch(`${OSEC_REGISTRY_URL}/status/${programId.toString()}`);
        if (!resp.ok)
          return null;
        const build = await resp.json();
        return build.is_verified ? build : null;
      } catch {
        return null;
      }
    }
    exports.verifiedBuild = verifiedBuild;
    async function fetchData(connection, programId) {
      const accountInfo = await connection.getAccountInfo(programId);
      if (accountInfo === null) {
        throw new Error("program account not found");
      }
      const { program } = decodeUpgradeableLoaderState(accountInfo.data);
      const programdataAccountInfo = await connection.getAccountInfo(program.programdataAddress);
      if (programdataAccountInfo === null) {
        throw new Error("program data account not found");
      }
      const { programData } = decodeUpgradeableLoaderState(programdataAccountInfo.data);
      return programData;
    }
    exports.fetchData = fetchData;
    var UPGRADEABLE_LOADER_STATE_LAYOUT = borsh.rustEnum([
      borsh.struct([], "uninitialized"),
      borsh.struct([borsh.option(borsh.publicKey(), "authorityAddress")], "buffer"),
      borsh.struct([borsh.publicKey("programdataAddress")], "program"),
      borsh.struct([
        borsh.u64("slot"),
        borsh.option(borsh.publicKey(), "upgradeAuthorityAddress")
      ], "programData")
    ], void 0, borsh.u32());
    function decodeUpgradeableLoaderState(data) {
      return UPGRADEABLE_LOADER_STATE_LAYOUT.decode(data);
    }
    exports.decodeUpgradeableLoaderState = decodeUpgradeableLoaderState;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/index.js
var require_utils2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/utils/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.registry = exports.features = exports.token = exports.bytes = exports.publicKey = exports.rpc = exports.sha256 = void 0;
    exports.sha256 = __importStar(require_sha2562());
    exports.rpc = __importStar(require_rpc());
    exports.publicKey = __importStar(require_pubkey());
    exports.bytes = __importStar(require_bytes());
    exports.token = __importStar(require_token());
    exports.features = __importStar(require_features());
    exports.registry = __importStar(require_registry());
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/event.js
var require_event2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/event.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.EventParser = exports.EventManager = void 0;
    var PROGRAM_LOG = "Program log: ";
    var PROGRAM_DATA = "Program data: ";
    var PROGRAM_LOG_START_INDEX = PROGRAM_LOG.length;
    var PROGRAM_DATA_START_INDEX = PROGRAM_DATA.length;
    var EventManager = class {
      constructor(programId, provider, coder2) {
        this._programId = programId;
        this._provider = provider;
        this._eventParser = new EventParser(programId, coder2);
        this._eventCallbacks = /* @__PURE__ */ new Map();
        this._eventListeners = /* @__PURE__ */ new Map();
        this._listenerIdCount = 0;
      }
      addEventListener(eventName, callback, commitment) {
        var _a;
        let listener = this._listenerIdCount;
        this._listenerIdCount += 1;
        if (!this._eventListeners.has(eventName)) {
          this._eventListeners.set(eventName, []);
        }
        this._eventListeners.set(eventName, ((_a = this._eventListeners.get(eventName)) !== null && _a !== void 0 ? _a : []).concat(listener));
        this._eventCallbacks.set(listener, [eventName, callback]);
        if (this._onLogsSubscriptionId !== void 0) {
          return listener;
        }
        this._onLogsSubscriptionId = this._provider.connection.onLogs(this._programId, (logs, ctx) => {
          if (logs.err) {
            return;
          }
          for (const event of this._eventParser.parseLogs(logs.logs)) {
            const allListeners = this._eventListeners.get(event.name);
            if (allListeners) {
              allListeners.forEach((listener2) => {
                const listenerCb = this._eventCallbacks.get(listener2);
                if (listenerCb) {
                  const [, callback2] = listenerCb;
                  callback2(event.data, ctx.slot, logs.signature);
                }
              });
            }
          }
        }, commitment);
        return listener;
      }
      async removeEventListener(listener) {
        const callback = this._eventCallbacks.get(listener);
        if (!callback) {
          throw new Error(`Event listener ${listener} doesn't exist!`);
        }
        const [eventName] = callback;
        let listeners = this._eventListeners.get(eventName);
        if (!listeners) {
          throw new Error(`Event listeners don't exist for ${eventName}!`);
        }
        this._eventCallbacks.delete(listener);
        listeners = listeners.filter((l) => l !== listener);
        this._eventListeners.set(eventName, listeners);
        if (listeners.length === 0) {
          this._eventListeners.delete(eventName);
        }
        if (this._eventCallbacks.size === 0) {
          if (this._eventListeners.size !== 0) {
            throw new Error(`Expected event listeners size to be 0 but got ${this._eventListeners.size}`);
          }
          if (this._onLogsSubscriptionId !== void 0) {
            await this._provider.connection.removeOnLogsListener(this._onLogsSubscriptionId);
            this._onLogsSubscriptionId = void 0;
          }
        }
      }
    };
    exports.EventManager = EventManager;
    var EventParser = class _EventParser {
      constructor(programId, coder2) {
        this.coder = coder2;
        this.programId = programId;
      }
      // Each log given, represents an array of messages emitted by
      // a single transaction, which can execute many different programs across
      // CPI boundaries. However, the subscription is only interested in the
      // events emitted by *this* program. In achieving this, we keep track of the
      // program execution context by parsing each log and looking for a CPI
      // `invoke` call. If one exists, we know a new program is executing. So we
      // push the programId onto a stack and switch the program context. This
      // allows us to track, for a given log, which program was executing during
      // its emission, thereby allowing us to know if a given log event was
      // emitted by *this* program. If it was, then we parse the raw string and
      // emit the event if the string matches the event being subscribed to.
      *parseLogs(logs, errorOnDecodeFailure = false) {
        const scanner = new LogScanner([...logs]);
        const execution = new ExecutionContext();
        const firstLog = scanner.next();
        if (firstLog === null)
          return;
        const firstCap = _EventParser.INVOKE_RE.exec(firstLog);
        if (!firstCap || firstCap[2] !== _EventParser.ROOT_DEPTH) {
          throw new Error(`Unexpected first log line: ${firstLog}`);
        }
        execution.push(firstCap[1]);
        while (scanner.peek() !== null) {
          const log = scanner.next();
          if (log === null)
            break;
          let [event, newProgram, didPop] = this.handleLog(execution, log, errorOnDecodeFailure);
          if (event)
            yield event;
          if (newProgram)
            execution.push(newProgram);
          if (didPop) {
            execution.pop();
            const nextLog = scanner.peek();
            if (nextLog && nextLog.endsWith("invoke [1]")) {
              const m = _EventParser.INVOKE_RE.exec(nextLog);
              if (m)
                execution.push(m[1]);
            }
          }
        }
      }
      // Main log handler. Returns a three element array of the event, the
      // next program that was invoked for CPI, and a boolean indicating if
      // a program has completed execution (and thus should be popped off the
      // execution stack).
      handleLog(execution, log, errorOnDecodeFailure) {
        if (execution.stack.length > 0 && execution.program() === this.programId.toString()) {
          return this.handleProgramLog(log, errorOnDecodeFailure);
        } else {
          return [null, ...this.handleSystemLog(log)];
        }
      }
      // Handles logs from *this* program.
      handleProgramLog(log, errorOnDecodeFailure) {
        if (log.startsWith(PROGRAM_LOG) || log.startsWith(PROGRAM_DATA)) {
          const logStr = log.startsWith(PROGRAM_LOG) ? log.slice(PROGRAM_LOG_START_INDEX) : log.slice(PROGRAM_DATA_START_INDEX);
          const event = this.coder.events.decode(logStr);
          if (errorOnDecodeFailure && event === null) {
            throw new Error(`Unable to decode event ${logStr}`);
          }
          return [event, null, false];
        } else {
          return [null, ...this.handleSystemLog(log)];
        }
      }
      // Handles logs when the current program being executing is *not* this.
      handleSystemLog(log) {
        const invokeMatch = _EventParser.INVOKE_RE.exec(log);
        if (invokeMatch && invokeMatch[1] === this.programId.toString()) {
          return [this.programId.toString(), false];
        } else if (log.startsWith(`Program ${this.programId.toString()} log: `)) {
          return [this.programId.toString(), false];
        } else if (invokeMatch && invokeMatch[2] !== _EventParser.ROOT_DEPTH) {
          return ["cpi", false];
        } else {
          let regex = /^Program ([1-9A-HJ-NP-Za-km-z]+) success$/;
          if (regex.test(log)) {
            return [null, true];
          } else {
            return [null, false];
          }
        }
      }
    };
    exports.EventParser = EventParser;
    EventParser.INVOKE_RE = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/;
    EventParser.ROOT_DEPTH = "1";
    var ExecutionContext = class {
      constructor() {
        this.stack = [];
      }
      program() {
        if (!this.stack.length) {
          throw new Error("Expected the stack to have elements");
        }
        return this.stack[this.stack.length - 1];
      }
      push(newProgram) {
        this.stack.push(newProgram);
      }
      pop() {
        if (!this.stack.length) {
          throw new Error("Expected the stack to have elements");
        }
        this.stack.pop();
      }
    };
    var LogScanner = class {
      constructor(logs) {
        this.logs = logs;
        this.logs = this.logs.filter((log) => log.startsWith("Program "));
      }
      next() {
        if (this.logs.length === 0) {
          return null;
        }
        let l = this.logs[0];
        this.logs = this.logs.slice(1);
        return l;
      }
      peek() {
        return this.logs.length > 0 ? this.logs[0] : null;
      }
    };
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/context.js
var require_context = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/context.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.splitArgsAndCtx = void 0;
    function splitArgsAndCtx(idlIx, args) {
      var _a, _b;
      let options = {};
      const inputLen = idlIx.args ? idlIx.args.length : 0;
      if (args.length > inputLen) {
        if (args.length !== inputLen + 1) {
          throw new Error(`provided too many arguments ${args} to instruction ${idlIx === null || idlIx === void 0 ? void 0 : idlIx.name} expecting: ${(_b = (_a = idlIx.args) === null || _a === void 0 ? void 0 : _a.map((a) => a.name)) !== null && _b !== void 0 ? _b : []}`);
        }
        options = args.pop();
      }
      return [args, options];
    }
    exports.splitArgsAndCtx = splitArgsAndCtx;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/instruction.js
var require_instruction3 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/instruction.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    var web3_js_1 = __require("@solana/web3.js");
    var idl_js_1 = require_idl();
    var error_js_1 = require_error();
    var common_js_1 = require_common3();
    var context_js_1 = require_context();
    var features = __importStar(require_features());
    var InstructionNamespaceFactory = class _InstructionNamespaceFactory {
      static build(idlIx, encodeFn, programId) {
        if (idlIx.name === "_inner") {
          throw new error_js_1.IdlError("the _inner name is reserved");
        }
        const ix = (...args) => {
          const [ixArgs, ctx] = (0, context_js_1.splitArgsAndCtx)(idlIx, [...args]);
          (0, common_js_1.validateAccounts)(idlIx.accounts, ctx.accounts);
          validateInstruction(idlIx, ...args);
          const keys = ix.accounts(ctx.accounts);
          if (ctx.remainingAccounts !== void 0) {
            keys.push(...ctx.remainingAccounts);
          }
          if (features.isSet("debug-logs")) {
            console.log("Outgoing account metas:", keys);
          }
          return new web3_js_1.TransactionInstruction({
            keys,
            programId,
            data: encodeFn(idlIx.name, (0, common_js_1.toInstruction)(idlIx, ...ixArgs))
          });
        };
        ix["accounts"] = (accs) => {
          return _InstructionNamespaceFactory.accountsArray(accs, idlIx.accounts, programId, idlIx.name);
        };
        return ix;
      }
      static accountsArray(ctx, accounts, programId, ixName) {
        if (!ctx) {
          return [];
        }
        return accounts.map((acc) => {
          if ((0, idl_js_1.isCompositeAccounts)(acc)) {
            const rpcAccs = ctx[acc.name];
            return _InstructionNamespaceFactory.accountsArray(rpcAccs, acc.accounts, programId, ixName).flat();
          }
          let pubkey;
          try {
            pubkey = (0, common_js_1.translateAddress)(ctx[acc.name]);
          } catch (err) {
            throw new Error(`Wrong input type for account "${acc.name}" in the instruction accounts object${ixName !== void 0 ? ' for instruction "' + ixName + '"' : ""}. Expected PublicKey or string.`);
          }
          const isOptional = acc.optional && pubkey.equals(programId);
          const isWritable = Boolean(acc.writable && !isOptional);
          const isSigner = Boolean(acc.signer && !isOptional);
          return {
            pubkey,
            isWritable,
            isSigner
          };
        }).flat();
      }
    };
    exports.default = InstructionNamespaceFactory;
    function validateInstruction(ix, ...args) {
    }
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/transaction.js
var require_transaction = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/transaction.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var web3_js_1 = __require("@solana/web3.js");
    var context_js_1 = require_context();
    var TransactionFactory = class {
      static build(idlIx, ixFn) {
        const txFn = (...args) => {
          var _a, _b, _c;
          const [, ctx] = (0, context_js_1.splitArgsAndCtx)(idlIx, [...args]);
          const tx = new web3_js_1.Transaction();
          if (ctx.preInstructions && ctx.instructions) {
            throw new Error("instructions is deprecated, use preInstructions");
          }
          (_a = ctx.preInstructions) === null || _a === void 0 ? void 0 : _a.forEach((ix) => tx.add(ix));
          (_b = ctx.instructions) === null || _b === void 0 ? void 0 : _b.forEach((ix) => tx.add(ix));
          tx.add(ixFn(...args));
          (_c = ctx.postInstructions) === null || _c === void 0 ? void 0 : _c.forEach((ix) => tx.add(ix));
          return tx;
        };
        return txFn;
      }
    };
    exports.default = TransactionFactory;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/rpc.js
var require_rpc2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/rpc.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var context_js_1 = require_context();
    var error_js_1 = require_error();
    var RpcFactory = class {
      static build(idlIx, txFn, idlErrors, provider) {
        const rpc = async (...args) => {
          var _a;
          const tx = txFn(...args);
          const [, ctx] = (0, context_js_1.splitArgsAndCtx)(idlIx, [...args]);
          if (provider.sendAndConfirm === void 0) {
            throw new Error("This function requires 'Provider.sendAndConfirm' to be implemented.");
          }
          try {
            return await provider.sendAndConfirm(tx, (_a = ctx.signers) !== null && _a !== void 0 ? _a : [], ctx.options);
          } catch (err) {
            throw (0, error_js_1.translateError)(err, idlErrors);
          }
        };
        return rpc;
      }
    };
    exports.default = RpcFactory;
  }
});

// sdk/node_modules/.pnpm/eventemitter3@4.0.7/node_modules/eventemitter3/index.js
var require_eventemitter3 = __commonJS({
  "sdk/node_modules/.pnpm/eventemitter3@4.0.7/node_modules/eventemitter3/index.js"(exports, module) {
    "use strict";
    var has = Object.prototype.hasOwnProperty;
    var prefix = "~";
    function Events() {
    }
    if (Object.create) {
      Events.prototype = /* @__PURE__ */ Object.create(null);
      if (!new Events().__proto__) prefix = false;
    }
    function EE(fn, context, once) {
      this.fn = fn;
      this.context = context;
      this.once = once || false;
    }
    function addListener(emitter, event, fn, context, once) {
      if (typeof fn !== "function") {
        throw new TypeError("The listener must be a function");
      }
      var listener = new EE(fn, context || emitter, once), evt = prefix ? prefix + event : event;
      if (!emitter._events[evt]) emitter._events[evt] = listener, emitter._eventsCount++;
      else if (!emitter._events[evt].fn) emitter._events[evt].push(listener);
      else emitter._events[evt] = [emitter._events[evt], listener];
      return emitter;
    }
    function clearEvent(emitter, evt) {
      if (--emitter._eventsCount === 0) emitter._events = new Events();
      else delete emitter._events[evt];
    }
    function EventEmitter() {
      this._events = new Events();
      this._eventsCount = 0;
    }
    EventEmitter.prototype.eventNames = function eventNames() {
      var names = [], events, name;
      if (this._eventsCount === 0) return names;
      for (name in events = this._events) {
        if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
      }
      if (Object.getOwnPropertySymbols) {
        return names.concat(Object.getOwnPropertySymbols(events));
      }
      return names;
    };
    EventEmitter.prototype.listeners = function listeners(event) {
      var evt = prefix ? prefix + event : event, handlers = this._events[evt];
      if (!handlers) return [];
      if (handlers.fn) return [handlers.fn];
      for (var i = 0, l = handlers.length, ee = new Array(l); i < l; i++) {
        ee[i] = handlers[i].fn;
      }
      return ee;
    };
    EventEmitter.prototype.listenerCount = function listenerCount(event) {
      var evt = prefix ? prefix + event : event, listeners = this._events[evt];
      if (!listeners) return 0;
      if (listeners.fn) return 1;
      return listeners.length;
    };
    EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return false;
      var listeners = this._events[evt], len = arguments.length, args, i;
      if (listeners.fn) {
        if (listeners.once) this.removeListener(event, listeners.fn, void 0, true);
        switch (len) {
          case 1:
            return listeners.fn.call(listeners.context), true;
          case 2:
            return listeners.fn.call(listeners.context, a1), true;
          case 3:
            return listeners.fn.call(listeners.context, a1, a2), true;
          case 4:
            return listeners.fn.call(listeners.context, a1, a2, a3), true;
          case 5:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
          case 6:
            return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
        }
        for (i = 1, args = new Array(len - 1); i < len; i++) {
          args[i - 1] = arguments[i];
        }
        listeners.fn.apply(listeners.context, args);
      } else {
        var length = listeners.length, j;
        for (i = 0; i < length; i++) {
          if (listeners[i].once) this.removeListener(event, listeners[i].fn, void 0, true);
          switch (len) {
            case 1:
              listeners[i].fn.call(listeners[i].context);
              break;
            case 2:
              listeners[i].fn.call(listeners[i].context, a1);
              break;
            case 3:
              listeners[i].fn.call(listeners[i].context, a1, a2);
              break;
            case 4:
              listeners[i].fn.call(listeners[i].context, a1, a2, a3);
              break;
            default:
              if (!args) for (j = 1, args = new Array(len - 1); j < len; j++) {
                args[j - 1] = arguments[j];
              }
              listeners[i].fn.apply(listeners[i].context, args);
          }
        }
      }
      return true;
    };
    EventEmitter.prototype.on = function on(event, fn, context) {
      return addListener(this, event, fn, context, false);
    };
    EventEmitter.prototype.once = function once(event, fn, context) {
      return addListener(this, event, fn, context, true);
    };
    EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
      var evt = prefix ? prefix + event : event;
      if (!this._events[evt]) return this;
      if (!fn) {
        clearEvent(this, evt);
        return this;
      }
      var listeners = this._events[evt];
      if (listeners.fn) {
        if (listeners.fn === fn && (!once || listeners.once) && (!context || listeners.context === context)) {
          clearEvent(this, evt);
        }
      } else {
        for (var i = 0, events = [], length = listeners.length; i < length; i++) {
          if (listeners[i].fn !== fn || once && !listeners[i].once || context && listeners[i].context !== context) {
            events.push(listeners[i]);
          }
        }
        if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
        else clearEvent(this, evt);
      }
      return this;
    };
    EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
      var evt;
      if (event) {
        evt = prefix ? prefix + event : event;
        if (this._events[evt]) clearEvent(this, evt);
      } else {
        this._events = new Events();
        this._eventsCount = 0;
      }
      return this;
    };
    EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
    EventEmitter.prototype.addListener = EventEmitter.prototype.on;
    EventEmitter.prefixed = prefix;
    EventEmitter.EventEmitter = EventEmitter;
    if ("undefined" !== typeof module) {
      module.exports = EventEmitter;
    }
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/account.js
var require_account = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/account.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AccountClient = void 0;
    var eventemitter3_1 = __importDefault(require_eventemitter3());
    var web3_js_1 = __require("@solana/web3.js");
    var provider_js_1 = require_provider();
    var index_js_1 = require_coder();
    var common_js_1 = require_common3();
    var rpcUtil = __importStar(require_rpc());
    var AccountFactory = class {
      static build(idl, coder2, programId, provider) {
        var _a;
        return ((_a = idl.accounts) !== null && _a !== void 0 ? _a : []).reduce((accountFns, acc) => {
          accountFns[acc.name] = new AccountClient(idl, acc, programId, provider, coder2);
          return accountFns;
        }, {});
      }
    };
    exports.default = AccountFactory;
    var AccountClient = class {
      /**
       * Returns the number of bytes in this account.
       */
      get size() {
        return this._size;
      }
      /**
       * Returns the program ID owning all accounts.
       */
      get programId() {
        return this._programId;
      }
      /**
       * Returns the client's wallet and network provider.
       */
      get provider() {
        return this._provider;
      }
      /**
       * Returns the coder.
       */
      get coder() {
        return this._coder;
      }
      constructor(idl, idlAccount, programId, provider, coder2) {
        this._idlAccount = idlAccount;
        this._programId = programId;
        this._provider = provider !== null && provider !== void 0 ? provider : (0, provider_js_1.getProvider)();
        this._coder = coder2 !== null && coder2 !== void 0 ? coder2 : new index_js_1.BorshCoder(idl);
        this._size = this._coder.accounts.size(idlAccount.name);
      }
      /**
       * Returns a deserialized account, returning null if it doesn't exist.
       *
       * @param address The address of the account to fetch.
       */
      async fetchNullable(address, commitment) {
        const { data } = await this.fetchNullableAndContext(address, commitment);
        return data;
      }
      /**
       * Returns a deserialized account along with the associated rpc response context, returning null if it doesn't exist.
       *
       * @param address The address of the account to fetch.
       */
      async fetchNullableAndContext(address, commitment) {
        const accountInfo = await this.getAccountInfoAndContext(address, commitment);
        const { value, context } = accountInfo;
        return {
          data: value && value.data.length !== 0 ? this._coder.accounts.decode(this._idlAccount.name, value.data) : null,
          context
        };
      }
      /**
       * Returns a deserialized account.
       *
       * @param address The address of the account to fetch.
       */
      async fetch(address, commitment) {
        const { data } = await this.fetchNullableAndContext(address, commitment);
        if (data === null) {
          throw new Error(`Account does not exist or has no data ${address.toString()}`);
        }
        return data;
      }
      /**
       * Returns a deserialized account along with the associated rpc response context.
       *
       * @param address The address of the account to fetch.
       */
      async fetchAndContext(address, commitment) {
        const { data, context } = await this.fetchNullableAndContext(address, commitment);
        if (data === null) {
          throw new Error(`Account does not exist ${address.toString()}`);
        }
        return { data, context };
      }
      /**
       * Returns multiple deserialized accounts.
       * Accounts not found or with wrong discriminator are returned as null.
       *
       * @param addresses The addresses of the accounts to fetch.
       */
      async fetchMultiple(addresses, commitment) {
        const accounts = await this.fetchMultipleAndContext(addresses, commitment);
        return accounts.map((account) => account ? account.data : null);
      }
      /**
       * Returns multiple deserialized accounts.
       * Accounts not found or with wrong discriminator are returned as null.
       *
       * @param addresses The addresses of the accounts to fetch.
       */
      async fetchMultipleAndContext(addresses, commitment) {
        const accounts = await rpcUtil.getMultipleAccountsAndContext(this._provider.connection, addresses.map((address) => (0, common_js_1.translateAddress)(address)), commitment);
        return accounts.map((result) => {
          if (result == null) {
            return null;
          }
          const { account, context } = result;
          return {
            data: this._coder.accounts.decode(this._idlAccount.name, account.data),
            context
          };
        });
      }
      /**
       * Returns all instances of this account type for the program.
       *
       * @param filters User-provided filters to narrow the results from `connection.getProgramAccounts`.
       *
       *                When filters are not defined this method returns all
       *                the account instances.
       *
       *                When filters are of type `Buffer`, the filters are appended
       *                after the discriminator.
       *
       *                When filters are of type `GetProgramAccountsFilter[]`,
       *                filters are appended after the discriminator filter.
       */
      async all(filters) {
        const filter = this.coder.accounts.memcmp(this._idlAccount.name, filters instanceof Buffer ? filters : void 0);
        const coderFilters = [];
        if ((filter === null || filter === void 0 ? void 0 : filter.offset) != void 0 && (filter === null || filter === void 0 ? void 0 : filter.bytes) != void 0) {
          coderFilters.push({
            memcmp: { offset: filter.offset, bytes: filter.bytes }
          });
        }
        if ((filter === null || filter === void 0 ? void 0 : filter.dataSize) != void 0) {
          coderFilters.push({ dataSize: filter.dataSize });
        }
        let resp = await this._provider.connection.getProgramAccounts(this._programId, {
          commitment: this._provider.connection.commitment,
          filters: [...coderFilters, ...Array.isArray(filters) ? filters : []]
        });
        return resp.map(({ pubkey, account }) => {
          return {
            publicKey: pubkey,
            account: this._coder.accounts.decode(this._idlAccount.name, account.data)
          };
        });
      }
      /**
       * Returns an `EventEmitter` emitting a "change" event whenever the account
       * changes.
       */
      subscribe(address, commitment) {
        const sub = subscriptions.get(address.toString());
        if (sub) {
          return sub.ee;
        }
        const ee = new eventemitter3_1.default();
        address = (0, common_js_1.translateAddress)(address);
        const listener = this._provider.connection.onAccountChange(address, (acc) => {
          const account = this._coder.accounts.decode(this._idlAccount.name, acc.data);
          ee.emit("change", account);
        }, commitment);
        subscriptions.set(address.toString(), {
          ee,
          listener
        });
        return ee;
      }
      /**
       * Unsubscribes from the account at the given address.
       */
      async unsubscribe(address) {
        let sub = subscriptions.get(address.toString());
        if (!sub) {
          console.warn("Address is not subscribed");
          return;
        }
        if (subscriptions) {
          await this._provider.connection.removeAccountChangeListener(sub.listener).then(() => {
            subscriptions.delete(address.toString());
          }).catch(console.error);
        }
      }
      /**
       * Returns an instruction for creating this account.
       */
      async createInstruction(signer, sizeOverride) {
        const size = this.size;
        if (this._provider.publicKey === void 0) {
          throw new Error("This function requires the Provider interface implementor to have a 'publicKey' field.");
        }
        return web3_js_1.SystemProgram.createAccount({
          fromPubkey: this._provider.publicKey,
          newAccountPubkey: signer.publicKey,
          space: sizeOverride !== null && sizeOverride !== void 0 ? sizeOverride : size,
          lamports: await this._provider.connection.getMinimumBalanceForRentExemption(sizeOverride !== null && sizeOverride !== void 0 ? sizeOverride : size),
          programId: this._programId
        });
      }
      async getAccountInfo(address, commitment) {
        return await this._provider.connection.getAccountInfo((0, common_js_1.translateAddress)(address), commitment);
      }
      async getAccountInfoAndContext(address, commitment) {
        return await this._provider.connection.getAccountInfoAndContext((0, common_js_1.translateAddress)(address), commitment);
      }
    };
    exports.AccountClient = AccountClient;
    var subscriptions = /* @__PURE__ */ new Map();
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/simulate.js
var require_simulate = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/simulate.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var context_js_1 = require_context();
    var event_js_1 = require_event2();
    var error_js_1 = require_error();
    var SimulateFactory = class {
      static build(idlIx, txFn, idlErrors, provider, coder2, programId, idl) {
        const simulate = async (...args) => {
          var _a;
          const tx = txFn(...args);
          const [, ctx] = (0, context_js_1.splitArgsAndCtx)(idlIx, [...args]);
          let resp = void 0;
          if (provider.simulate === void 0) {
            throw new Error("This function requires 'Provider.simulate' to be implemented.");
          }
          try {
            resp = await provider.simulate(tx, ctx.signers, (_a = ctx.options) === null || _a === void 0 ? void 0 : _a.commitment);
          } catch (err) {
            throw (0, error_js_1.translateError)(err, idlErrors);
          }
          if (resp === void 0) {
            throw new Error("Unable to simulate transaction");
          }
          const logs = resp.logs;
          if (!logs) {
            throw new Error("Simulated logs not found");
          }
          const events = [];
          if (idl.events) {
            let parser = new event_js_1.EventParser(programId, coder2);
            for (const event of parser.parseLogs(logs)) {
              events.push(event);
            }
          }
          return { events, raw: logs };
        };
        return simulate;
      }
    };
    exports.default = SimulateFactory;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/token-account-layout.js
var require_token_account_layout = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/token-account-layout.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.decodeTokenAccount = void 0;
    var bn_js_1 = __importDefault(require_bn());
    var BufferLayout = __importStar(require_Layout());
    var buffer_layout_1 = require_Layout();
    var web3_js_1 = __require("@solana/web3.js");
    function uint64(property) {
      return new WrappedLayout(BufferLayout.blob(8), (b) => u64.fromBuffer(b), (n) => n.toBuffer(), property);
    }
    function publicKey(property) {
      return new WrappedLayout(BufferLayout.blob(32), (b) => new web3_js_1.PublicKey(b), (key2) => key2.toBuffer(), property);
    }
    function coption(layout, property) {
      return new COptionLayout(layout, property);
    }
    var WrappedLayout = class extends buffer_layout_1.Layout {
      constructor(layout, decoder, encoder, property) {
        super(layout.span, property);
        this.layout = layout;
        this.decoder = decoder;
        this.encoder = encoder;
      }
      decode(b, offset) {
        return this.decoder(this.layout.decode(b, offset));
      }
      encode(src, b, offset) {
        return this.layout.encode(this.encoder(src), b, offset);
      }
      getSpan(b, offset) {
        return this.layout.getSpan(b, offset);
      }
    };
    var COptionLayout = class extends buffer_layout_1.Layout {
      constructor(layout, property) {
        super(-1, property);
        this.layout = layout;
        this.discriminator = BufferLayout.u32();
      }
      encode(src, b, offset = 0) {
        if (src === null || src === void 0) {
          return this.layout.span + this.discriminator.encode(0, b, offset);
        }
        this.discriminator.encode(1, b, offset);
        return this.layout.encode(src, b, offset + 4) + 4;
      }
      decode(b, offset = 0) {
        const discriminator = this.discriminator.decode(b, offset);
        if (discriminator === 0) {
          return null;
        } else if (discriminator === 1) {
          return this.layout.decode(b, offset + 4);
        }
        throw new Error("Invalid coption " + this.layout.property);
      }
      getSpan(b, offset = 0) {
        return this.layout.getSpan(b, offset + 4) + 4;
      }
    };
    var u64 = class _u64 extends bn_js_1.default {
      /**
       * Convert to Buffer representation
       */
      toBuffer() {
        const a = super.toArray().reverse();
        const b = Buffer.from(a);
        if (b.length === 8) {
          return b;
        }
        if (b.length >= 8) {
          throw new Error("u64 too large");
        }
        const zeroPad = Buffer.alloc(8);
        b.copy(zeroPad);
        return zeroPad;
      }
      /**
       * Construct a u64 from Buffer representation
       */
      static fromBuffer(buffer) {
        if (buffer.length !== 8) {
          throw new Error(`Invalid buffer length: ${buffer.length}`);
        }
        return new _u64([...buffer].reverse().map((i) => `00${i.toString(16)}`.slice(-2)).join(""), 16);
      }
    };
    var TOKEN_ACCOUNT_LAYOUT = BufferLayout.struct([
      publicKey("mint"),
      publicKey("owner"),
      uint64("amount"),
      coption(publicKey(), "delegate"),
      ((p) => {
        const U = BufferLayout.union(BufferLayout.u8("discriminator"), null, p);
        U.addVariant(0, BufferLayout.struct([]), "uninitialized");
        U.addVariant(1, BufferLayout.struct([]), "initialized");
        U.addVariant(2, BufferLayout.struct([]), "frozen");
        return U;
      })("state"),
      coption(uint64(), "isNative"),
      uint64("delegatedAmount"),
      coption(publicKey(), "closeAuthority")
    ]);
    function decodeTokenAccount(b) {
      return TOKEN_ACCOUNT_LAYOUT.decode(b);
    }
    exports.decodeTokenAccount = decodeTokenAccount;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/accounts-resolver.js
var require_accounts_resolver = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/accounts-resolver.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AccountsResolver = exports.isAccountsGeneric = void 0;
    var bn_js_1 = __importDefault(require_bn());
    var web3_js_1 = __require("@solana/web3.js");
    var idl_js_1 = require_idl();
    var token_account_layout_1 = require_token_account_layout();
    var index_js_1 = require_program();
    var methods_1 = require_methods();
    function isAccountsGeneric(accounts) {
      return !(accounts instanceof web3_js_1.PublicKey);
    }
    exports.isAccountsGeneric = isAccountsGeneric;
    var AccountsResolver = class {
      constructor(_args, _accounts, _provider, _programId, _idlIx, accountNamespace, _idlTypes, _customResolver) {
        this._args = _args;
        this._accounts = _accounts;
        this._provider = _provider;
        this._programId = _programId;
        this._idlIx = _idlIx;
        this._idlTypes = _idlTypes;
        this._customResolver = _customResolver;
        this._resolutionErrors = /* @__PURE__ */ new Map();
        this._accountStore = new AccountStore(_provider, accountNamespace, _programId);
      }
      args(args) {
        this._args = args;
      }
      // Note: We serially resolve PDAs one by one rather than doing them
      //       in parallel because there can be dependencies between
      //       addresses. That is, one PDA can be used as a seed in another.
      async resolve() {
        this._resolutionErrors.clear();
        this.resolveEventCpi(this._idlIx.accounts);
        this.resolveConst(this._idlIx.accounts);
        let depth = 0;
        while (await this.resolvePdasAndRelations(this._idlIx.accounts) + await this.resolveCustom() > 0) {
          depth++;
          if (depth === 16) {
            const selfRefPdas = this._idlIx.accounts.filter(this.isSelfReferencingPda.bind(this));
            const unresolvedSelfRefPdas = this.getUnresolvedAccounts(selfRefPdas);
            if (unresolvedSelfRefPdas.length) {
              throw new Error([
                "Self-referencing PDAs must be provided manually.",
                `Unresolved PDAs: ${this.formatAccountPaths(unresolvedSelfRefPdas)}`
              ].join(" "));
            }
            const resolvableAccs = this._idlIx.accounts.filter(this.isResolvable.bind(this));
            const unresolvedPaths = this.getUnresolvedAccounts(resolvableAccs);
            const unresolvedAccs = this.formatAccountPaths(unresolvedPaths);
            const parts = [
              `Reached maximum depth for account resolution.`,
              `Unresolved accounts: ${unresolvedAccs}`
            ];
            const relevantErrors = unresolvedPaths.map((path) => ({
              path: this.pathKey(path),
              error: this._resolutionErrors.get(this.pathKey(path))
            })).filter((entry) => entry.error !== void 0);
            if (relevantErrors.length > 0) {
              const causeMsgs = this.formatResolutionErrorDetails(relevantErrors);
              parts.push(`Errors encountered while resolving: ${causeMsgs.join("; ")}`);
            }
            const err = new Error(parts.join(" "));
            const cause = this.resolutionCause(relevantErrors);
            if (cause !== void 0) {
              err.cause = cause;
            }
            throw err;
          }
        }
      }
      getUnresolvedAccounts(accs) {
        return this.getPaths(accs).filter((path) => !this.get(path));
      }
      formatResolutionErrorDetails(relevantErrors) {
        return relevantErrors.map(({ path, error }) => {
          const msg = error instanceof Error ? error.message : String(error);
          return `\`${path}\`: ${msg}`;
        });
      }
      resolutionCause(relevantErrors) {
        if (relevantErrors.length === 0) {
          return void 0;
        }
        if (relevantErrors.length === 1) {
          return relevantErrors[0].error;
        }
        return new Error(this.formatResolutionErrorDetails(relevantErrors).join("; "));
      }
      pathKey(path) {
        return path.join(".");
      }
      formatAccountPaths(paths) {
        return paths.map((path) => path.reduce((acc, p) => acc + "." + p)).map((acc) => `\`${acc}\``).join(", ");
      }
      isSelfReferencingPda(acc) {
        if (!(0, idl_js_1.isCompositeAccounts)(acc)) {
          if (!acc.pda)
            return false;
          return acc.pda.seeds.some((seed) => {
            if (seed.kind !== "account")
              return false;
            const [name] = seed.path.split(".");
            return name === acc.name;
          });
        }
        return acc.accounts.some(this.isSelfReferencingPda.bind(this));
      }
      isResolvable(acc) {
        if (!(0, idl_js_1.isCompositeAccounts)(acc)) {
          return !!(acc.address || acc.pda || acc.relations);
        }
        return acc.accounts.some(this.isResolvable.bind(this));
      }
      getPaths(accs, path = [], paths = []) {
        for (const acc of accs) {
          if ((0, idl_js_1.isCompositeAccounts)(acc)) {
            paths.push(...this.getPaths(acc.accounts, [...path, acc.name]));
          } else {
            paths.push([...path, acc.name]);
          }
        }
        return paths;
      }
      resolveOptionals(accounts) {
        Object.assign(this._accounts, this.resolveOptionalsHelper(accounts, this._idlIx.accounts));
      }
      get(path) {
        const ret = path.reduce((acc, subPath) => acc && acc[subPath], this._accounts);
        if (ret && ret.toBase58) {
          return ret;
        }
      }
      set(path, value) {
        let cur = this._accounts;
        path.forEach((p, i) => {
          var _a;
          const isLast = i === path.length - 1;
          if (isLast) {
            cur[p] = value;
          }
          cur[p] = (_a = cur[p]) !== null && _a !== void 0 ? _a : {};
          cur = cur[p];
        });
      }
      resolveOptionalsHelper(partialAccounts, accounts) {
        const nestedAccountsGeneric = {};
        for (const accountItem of accounts) {
          const accountName = accountItem.name;
          const partialAccount = partialAccounts[accountName];
          if (partialAccount === void 0)
            continue;
          if ((0, methods_1.isPartialAccounts)(partialAccount)) {
            if ((0, idl_js_1.isCompositeAccounts)(accountItem)) {
              nestedAccountsGeneric[accountName] = this.resolveOptionalsHelper(partialAccount, accountItem["accounts"]);
            } else {
              nestedAccountsGeneric[accountName] = (0, methods_1.flattenPartialAccounts)(partialAccount, true);
            }
          } else {
            if (partialAccount !== null) {
              nestedAccountsGeneric[accountName] = (0, index_js_1.translateAddress)(partialAccount);
            } else if (accountItem["optional"]) {
              nestedAccountsGeneric[accountName] = this._programId;
            }
          }
        }
        return nestedAccountsGeneric;
      }
      async resolveCustom() {
        if (this._customResolver) {
          const { accounts, resolved } = await this._customResolver({
            args: this._args,
            accounts: this._accounts,
            provider: this._provider,
            programId: this._programId,
            idlIx: this._idlIx
          });
          this._accounts = accounts;
          return resolved;
        }
        return 0;
      }
      /**
       * Resolve event CPI accounts `eventAuthority` and `program`.
       *
       * Accounts will only be resolved if they are declared next to each other to
       * reduce the chance of name collision.
       */
      resolveEventCpi(accounts, path = []) {
        for (const i in accounts) {
          const accountOrAccounts = accounts[i];
          if ((0, idl_js_1.isCompositeAccounts)(accountOrAccounts)) {
            this.resolveEventCpi(accountOrAccounts.accounts, [
              ...path,
              accountOrAccounts.name
            ]);
          }
          const nextIndex = +i + 1;
          if (nextIndex === accounts.length)
            return;
          const currentName = accounts[i].name;
          const nextName = accounts[nextIndex].name;
          if (currentName === "eventAuthority" && nextName === "program") {
            const currentPath = [...path, currentName];
            const nextPath = [...path, nextName];
            if (!this.get(currentPath)) {
              this.set(currentPath, web3_js_1.PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this._programId)[0]);
            }
            if (!this.get(nextPath)) {
              this.set(nextPath, this._programId);
            }
            return;
          }
        }
      }
      resolveConst(accounts, path = []) {
        for (const accountOrAccounts of accounts) {
          const name = accountOrAccounts.name;
          if ((0, idl_js_1.isCompositeAccounts)(accountOrAccounts)) {
            this.resolveConst(accountOrAccounts.accounts, [...path, name]);
          } else {
            const account = accountOrAccounts;
            if ((account.signer || account.address) && !this.get([...path, name])) {
              if (account.signer) {
                if (!this._provider.publicKey) {
                  throw new Error("This function requires the `Provider` interface implementor to have a `publicKey` field.");
                }
                this.set([...path, name], this._provider.publicKey);
              }
              if (account.address) {
                this.set([...path, name], (0, index_js_1.translateAddress)(account.address));
              }
            }
          }
        }
      }
      async resolvePdasAndRelations(accounts, path = []) {
        let found = 0;
        for (const accountOrAccounts of accounts) {
          const name = accountOrAccounts.name;
          if ((0, idl_js_1.isCompositeAccounts)(accountOrAccounts)) {
            found += await this.resolvePdasAndRelations(accountOrAccounts.accounts, [...path, name]);
          } else {
            const account = accountOrAccounts;
            if ((account.pda || account.relations) && !this.get([...path, name])) {
              found++;
              if (await this.resolvePda(account, path, name)) {
                continue;
              }
              await this.resolveRelation(account, path, name);
            }
          }
        }
        return found;
      }
      async resolvePda(account, path, name) {
        if (!account.pda)
          return false;
        try {
          const seeds = await Promise.all(account.pda.seeds.map((seed) => this.toBuffer(seed, path)));
          if (seeds.some((seed) => !seed)) {
            return true;
          }
          const programId = await this.parseProgramId(account, path);
          const [pubkey] = web3_js_1.PublicKey.findProgramAddressSync(seeds, programId);
          this.set([...path, name], pubkey);
          this._resolutionErrors.delete(this.pathKey([...path, name]));
        } catch (err) {
          this._resolutionErrors.set(this.pathKey([...path, name]), err);
        }
        return false;
      }
      async resolveRelation(account, path, name) {
        if (!account.relations)
          return;
        try {
          const accountKey = this.get([...path, account.relations[0]]);
          if (accountKey) {
            const accountData = await this._accountStore.fetchAccount({
              publicKey: accountKey
            });
            this.set([...path, name], accountData[name]);
            this._resolutionErrors.delete(this.pathKey([...path, name]));
          }
        } catch (err) {
          this._resolutionErrors.set(this.pathKey([...path, name]), err);
        }
      }
      async parseProgramId(account, path = []) {
        var _a;
        if (!((_a = account.pda) === null || _a === void 0 ? void 0 : _a.program)) {
          return this._programId;
        }
        const buf = await this.toBuffer(account.pda.program, path);
        if (!buf) {
          throw new Error(`Program seed not resolved: ${account.name}`);
        }
        return new web3_js_1.PublicKey(buf);
      }
      async toBuffer(seed, path = []) {
        switch (seed.kind) {
          case "const":
            return this.toBufferConst(seed);
          case "arg":
            return await this.toBufferArg(seed);
          case "account":
            return await this.toBufferAccount(seed, path);
          default:
            throw new Error(`Unexpected seed: ${seed}`);
        }
      }
      toBufferConst(seed) {
        return this.toBufferValue("bytes", seed.value);
      }
      async toBufferArg(seed) {
        const [name, ...path] = seed.path.split(".");
        const index = this._idlIx.args.findIndex((arg) => arg.name === name);
        if (index === -1) {
          throw new Error(`Unable to find argument for seed: ${name}`);
        }
        const value = path.reduce((acc, path2) => (acc !== null && acc !== void 0 ? acc : {})[path2], this._args[index]);
        if (value === void 0) {
          return;
        }
        const type = this.getType(this._idlIx.args[index].type, path);
        return this.toBufferValue(type, value);
      }
      async toBufferAccount(seed, path = []) {
        const [name, ...paths] = seed.path.split(".");
        const fieldPubkey = this.get([...path, name]);
        if (!fieldPubkey)
          return;
        if (!paths.length) {
          return this.toBufferValue("pubkey", fieldPubkey);
        }
        if (!seed.account) {
          throw new Error(`Seed account is required in order to resolve type: ${seed.path}`);
        }
        const account = await this._accountStore.fetchAccount({
          publicKey: fieldPubkey,
          name: seed.account
        });
        let accountValue = account;
        let currentPaths = paths;
        while (currentPaths.length > 0) {
          accountValue = accountValue[currentPaths[0]];
          currentPaths = currentPaths.slice(1);
        }
        if (accountValue === void 0)
          return;
        const type = this.getType({ defined: { name: seed.account } }, paths);
        return this.toBufferValue(type, accountValue);
      }
      /**
       * Converts the given idl valaue into a Buffer. The values here must be
       * primitives, e.g. no structs.
       */
      toBufferValue(type, value) {
        switch (type) {
          case "u8":
          case "i8":
            return Buffer.from([value]);
          case "u16":
          case "i16":
            return new bn_js_1.default(value).toArrayLike(Buffer, "le", 2);
          case "u32":
          case "i32":
            return new bn_js_1.default(value).toArrayLike(Buffer, "le", 4);
          case "u64":
          case "i64":
            return new bn_js_1.default(value).toArrayLike(Buffer, "le", 8);
          case "u128":
          case "i128":
            return new bn_js_1.default(value).toArrayLike(Buffer, "le", 16);
          case "u256":
          case "i256":
            return new bn_js_1.default(value).toArrayLike(Buffer, "le", 32);
          case "string":
            return Buffer.from(value);
          case "pubkey":
            return value.toBuffer();
          case "bytes":
            return Buffer.from(value);
          default:
            if (type === null || type === void 0 ? void 0 : type.array) {
              return Buffer.from(value);
            }
            throw new Error(`Unexpected seed type: ${type}`);
        }
      }
      /**
       * Recursively get the type at some path of either a primitive or a user
       * defined struct.
       */
      getType(type, path = []) {
        var _a;
        const typeName = (_a = type === null || type === void 0 ? void 0 : type.defined) === null || _a === void 0 ? void 0 : _a.name;
        if (typeName) {
          if (typeName === "tokenAccount") {
            switch (path.at(0)) {
              case "mint":
              case "owner":
                return "pubkey";
              case "amount":
              case "delagatedAmount":
                return "u64";
              default:
                throw new Error(`Unknown token account path: ${path}`);
            }
          }
          const definedType = this._idlTypes.find((t) => t.name === typeName);
          if (!definedType) {
            throw new Error(`Type not found: ${typeName}`);
          }
          const [fieldName, ...subPath] = path;
          const fields = definedType.type.fields;
          const field = fields.find((field2) => field2.name === fieldName);
          if (!field) {
            throw new Error(`Field not found: ${fieldName}`);
          }
          return this.getType(field.type, subPath);
        }
        return type;
      }
    };
    exports.AccountsResolver = AccountsResolver;
    var AccountStore = class {
      constructor(_provider, accounts, programId) {
        this._provider = _provider;
        this._cache = /* @__PURE__ */ new Map();
        this._idls = {};
        this._idls[programId.toBase58()] = accounts;
      }
      async fetchAccount({ publicKey, name }) {
        const address = publicKey.toBase58();
        if (!this._cache.has(address)) {
          const accountInfo = await this._provider.connection.getAccountInfo(publicKey);
          if (accountInfo === null) {
            throw new Error(`Account not found: ${address}`);
          }
          if (name === "tokenAccount") {
            const account = (0, token_account_layout_1.decodeTokenAccount)(accountInfo.data);
            this._cache.set(address, account);
          } else {
            const accounts = await this.getAccountsNs(accountInfo.owner);
            if (accounts) {
              const accountNs = Object.values(accounts)[0];
              if (accountNs) {
                const account = accountNs.coder.accounts.decodeAny(accountInfo.data);
                this._cache.set(address, account);
              }
            }
          }
        }
        return this._cache.get(address);
      }
      async getAccountsNs(programId) {
        const programIdStr = programId.toBase58();
        if (!this._idls[programIdStr]) {
          const idl = await index_js_1.Program.fetchIdl(programId, this._provider);
          if (idl) {
            const program = new index_js_1.Program(idl, this._provider);
            this._idls[programIdStr] = program.account;
          }
        }
        return this._idls[programIdStr];
      }
    };
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/methods.js
var require_methods = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/methods.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MethodsBuilder = exports.flattenPartialAccounts = exports.isPartialAccounts = exports.MethodsBuilderFactory = void 0;
    var accounts_resolver_js_1 = require_accounts_resolver();
    var common_js_1 = require_common3();
    var MethodsBuilderFactory = class {
      static build(provider, programId, idlIx, ixFn, txFn, rpcFn, simulateFn, viewFn, accountNamespace, idlTypes, customResolver) {
        return (...args) => new MethodsBuilder(args, ixFn, txFn, rpcFn, simulateFn, viewFn, provider, programId, idlIx, accountNamespace, idlTypes, customResolver);
      }
    };
    exports.MethodsBuilderFactory = MethodsBuilderFactory;
    function isPartialAccounts(partialAccount) {
      return typeof partialAccount === "object" && partialAccount !== null && !("_bn" in partialAccount);
    }
    exports.isPartialAccounts = isPartialAccounts;
    function flattenPartialAccounts(partialAccounts, throwOnNull) {
      const toReturn = {};
      for (const accountName in partialAccounts) {
        const account = partialAccounts[accountName];
        if (account === null) {
          if (throwOnNull)
            throw new Error("Failed to resolve optionals due to IDL type mismatch with input accounts!");
          continue;
        }
        toReturn[accountName] = isPartialAccounts(account) ? flattenPartialAccounts(account, true) : (0, common_js_1.translateAddress)(account);
      }
      return toReturn;
    }
    exports.flattenPartialAccounts = flattenPartialAccounts;
    var MethodsBuilder = class {
      constructor(_args, _ixFn, _txFn, _rpcFn, _simulateFn, _viewFn, provider, programId, idlIx, accountNamespace, idlTypes, customResolver) {
        this._args = _args;
        this._ixFn = _ixFn;
        this._txFn = _txFn;
        this._rpcFn = _rpcFn;
        this._simulateFn = _simulateFn;
        this._viewFn = _viewFn;
        this._accounts = {};
        this._remainingAccounts = [];
        this._signers = [];
        this._preInstructions = [];
        this._postInstructions = [];
        this._resolveAccounts = true;
        this._accountsResolver = new accounts_resolver_js_1.AccountsResolver(_args, this._accounts, provider, programId, idlIx, accountNamespace, idlTypes, customResolver);
      }
      args(args) {
        this._args = args;
        this._accountsResolver.args(args);
      }
      /**
       * Set instruction accounts with account resolution.
       *
       * This method only accepts accounts that cannot be resolved.
       *
       * See {@link accountsPartial} for overriding the account resolution or
       * {@link accountsStrict} for strictly specifying all accounts.
       */
      accounts(accounts) {
        return this.accountsPartial(accounts);
      }
      /**
       * Set instruction accounts with account resolution.
       *
       * There is no functional difference between this method and {@link accounts}
       * method, the only difference is this method allows specifying all accounts
       * even if they can be resolved. On the other hand, {@link accounts} method
       * doesn't accept accounts that can be resolved.
       */
      accountsPartial(accounts) {
        this._resolveAccounts = true;
        this._accountsResolver.resolveOptionals(accounts);
        return this;
      }
      /**
       * Set instruction accounts without account resolution.
       *
       * All accounts strictly need to be specified when this method is used.
       *
       * See {@link accounts} and {@link accountsPartial} methods for automatically
       * resolving accounts.
       *
       * @param accounts instruction accounts
       */
      accountsStrict(accounts) {
        this._resolveAccounts = false;
        this._accountsResolver.resolveOptionals(accounts);
        return this;
      }
      /**
       * Set instruction signers.
       *
       * Note that calling this method appends the given signers to the existing
       * signers (instead of overriding them).
       *
       * @param signers signers to append
       */
      signers(signers) {
        this._signers = this._signers.concat(signers);
        return this;
      }
      /**
       * Set remaining accounts.
       *
       * Note that calling this method appends the given accounts to the existing
       * remaining accounts (instead of overriding them).
       *
       * @param accounts remaining accounts
       */
      remainingAccounts(accounts) {
        this._remainingAccounts = this._remainingAccounts.concat(accounts);
        return this;
      }
      /**
       * Set previous instructions.
       *
       * See {@link postInstructions} to set the post instructions instead.
       *
       * @param ixs instructions
       * @param prepend whether to prepend to the existing previous instructions
       */
      preInstructions(ixs, prepend = false) {
        if (prepend) {
          this._preInstructions = ixs.concat(this._preInstructions);
        } else {
          this._preInstructions = this._preInstructions.concat(ixs);
        }
        return this;
      }
      /**
       * Set post instructions.
       *
       * See {@link preInstructions} to set the previous instructions instead.
       *
       * @param ixs instructions
       */
      postInstructions(ixs) {
        this._postInstructions = this._postInstructions.concat(ixs);
        return this;
      }
      /**
       * Get the public keys of the instruction accounts.
       *
       * The return type is an object with account names as keys and their public
       * keys as their values.
       *
       * Note that an account key is `undefined` if the account hasn't yet been
       * specified or resolved.
       */
      async pubkeys() {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        return this._accounts;
      }
      /**
       * Create an instruction based on the current configuration.
       *
       * See {@link transaction} to create a transaction instead.
       *
       * @returns the transaction instruction
       */
      async instruction() {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        return this._ixFn(...this._args, {
          accounts: this._accounts,
          signers: this._signers,
          remainingAccounts: this._remainingAccounts,
          preInstructions: this._preInstructions,
          postInstructions: this._postInstructions
        });
      }
      /**
       * Create a transaction based on the current configuration.
       *
       * This method doesn't send the created transaction. Use {@link rpc} method
       * to conveniently send an confirm the configured transaction.
       *
       * See {@link instruction} to only create an instruction instead.
       *
       * @returns the transaction
       */
      async transaction() {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        return this._txFn(...this._args, {
          accounts: this._accounts,
          signers: this._signers,
          remainingAccounts: this._remainingAccounts,
          preInstructions: this._preInstructions,
          postInstructions: this._postInstructions
        });
      }
      /**
       * Simulate the configured transaction.
       *
       * @param options confirmation options
       * @returns the simulation response
       */
      async simulate(options) {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        return this._simulateFn(...this._args, {
          accounts: this._accounts,
          signers: this._signers,
          remainingAccounts: this._remainingAccounts,
          preInstructions: this._preInstructions,
          postInstructions: this._postInstructions,
          options
        });
      }
      /**
       * View the configured transaction.
       *
       * Note that to use this method, the instruction needs to return a value and
       * all its accounts must be read-only.
       *
       * @param options confirmation options
       * @returns the return value of the instruction
       */
      async view(options) {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        if (!this._viewFn) {
          throw new Error([
            "Method does not support views.",
            "The instruction should return a value, and its accounts must be read-only"
          ].join(" "));
        }
        return this._viewFn(...this._args, {
          accounts: this._accounts,
          signers: this._signers,
          remainingAccounts: this._remainingAccounts,
          preInstructions: this._preInstructions,
          postInstructions: this._postInstructions,
          options
        });
      }
      /**
       * Send and confirm the configured transaction.
       *
       * See {@link rpcAndKeys} to both send the transaction and get the resolved
       * account public keys.
       *
       * @param options confirmation options
       * @returns the transaction signature
       */
      async rpc(options) {
        if (this._resolveAccounts) {
          await this._accountsResolver.resolve();
        }
        return this._rpcFn(...this._args, {
          accounts: this._accounts,
          signers: this._signers,
          remainingAccounts: this._remainingAccounts,
          preInstructions: this._preInstructions,
          postInstructions: this._postInstructions,
          options
        });
      }
      /**
       * Conveniently call both {@link rpc} and {@link pubkeys} methods.
       *
       * @param options confirmation options
       * @returns the transaction signature and account public keys
       */
      async rpcAndKeys(options) {
        return {
          signature: await this.rpc(options),
          pubkeys: await this.pubkeys()
        };
      }
      /**
       * Get instruction information necessary to include the instruction inside a
       * transaction.
       *
       * # Example
       *
       * ```ts
       * const { instruction, signers, pubkeys } = await method.prepare();
       * ```
       */
      async prepare() {
        return {
          instruction: await this.instruction(),
          signers: this._signers,
          pubkeys: await this.pubkeys()
        };
      }
    };
    exports.MethodsBuilder = MethodsBuilder;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/views.js
var require_views = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/views.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    var idl_1 = require_idl2();
    var base64_1 = require_base64();
    var ViewFactory = class {
      static build(programId, idlIx, simulateFn, idl) {
        const isWritable = idlIx.accounts.find((a) => a.writable);
        const hasReturn = !!idlIx.returns;
        if (isWritable || !hasReturn)
          return;
        const view = async (...args) => {
          let simulationResult = await simulateFn(...args);
          const returnPrefix = `Program return: ${programId} `;
          let returnLog = simulationResult.raw.find((l) => l.startsWith(returnPrefix));
          if (!returnLog) {
            throw new Error("View expected return log");
          }
          let returnData = (0, base64_1.decode)(returnLog.slice(returnPrefix.length));
          let returnType = idlIx.returns;
          if (!returnType) {
            throw new Error("View expected return type");
          }
          const coder2 = idl_1.IdlCoder.fieldLayout({ type: returnType }, idl.types);
          return coder2.decode(returnData);
        };
        return view;
      }
    };
    exports.default = ViewFactory;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/index.js
var require_namespace = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/namespace/index.js"(exports) {
    "use strict";
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MethodsBuilderFactory = exports.AccountClient = void 0;
    var instruction_js_1 = __importDefault(require_instruction3());
    var transaction_js_1 = __importDefault(require_transaction());
    var rpc_js_1 = __importDefault(require_rpc2());
    var account_js_1 = __importDefault(require_account());
    var simulate_js_1 = __importDefault(require_simulate());
    var common_js_1 = require_common3();
    var methods_1 = require_methods();
    var views_1 = __importDefault(require_views());
    var account_js_2 = require_account();
    Object.defineProperty(exports, "AccountClient", { enumerable: true, get: function() {
      return account_js_2.AccountClient;
    } });
    var methods_2 = require_methods();
    Object.defineProperty(exports, "MethodsBuilderFactory", { enumerable: true, get: function() {
      return methods_2.MethodsBuilderFactory;
    } });
    var NamespaceFactory = class {
      /**
       * Generates all namespaces for a given program.
       */
      static build(idl, coder2, programId, provider, getCustomResolver) {
        const rpc = {};
        const instruction = {};
        const transaction = {};
        const simulate = {};
        const methods = {};
        const view = {};
        const idlErrors = (0, common_js_1.parseIdlErrors)(idl);
        const account = idl.accounts ? account_js_1.default.build(idl, coder2, programId, provider) : {};
        idl.instructions.forEach((idlIx) => {
          const ixItem = instruction_js_1.default.build(idlIx, (ixName, ix) => coder2.instruction.encode(ixName, ix), programId);
          const txItem = transaction_js_1.default.build(idlIx, ixItem);
          const rpcItem = rpc_js_1.default.build(idlIx, txItem, idlErrors, provider);
          const simulateItem = simulate_js_1.default.build(idlIx, txItem, idlErrors, provider, coder2, programId, idl);
          const viewItem = views_1.default.build(programId, idlIx, simulateItem, idl);
          const methodItem = methods_1.MethodsBuilderFactory.build(provider, programId, idlIx, ixItem, txItem, rpcItem, simulateItem, viewItem, account, idl.types || [], getCustomResolver === null || getCustomResolver === void 0 ? void 0 : getCustomResolver(idlIx));
          const name = idlIx.name;
          instruction[name] = ixItem;
          transaction[name] = txItem;
          rpc[name] = rpcItem;
          simulate[name] = simulateItem;
          methods[name] = methodItem;
          if (viewItem) {
            view[name] = viewItem;
          }
        });
        return [
          rpc,
          instruction,
          transaction,
          account,
          simulate,
          methods,
          view
        ];
      }
    };
    exports.default = NamespaceFactory;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/index.js
var require_program = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/program/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Program = void 0;
    var index_js_1 = require_coder();
    var idl_js_1 = require_idl();
    var provider_js_1 = require_provider();
    var common_js_1 = require_common3();
    var event_js_1 = require_event2();
    var index_js_2 = __importDefault(require_namespace());
    __exportStar(require_common3(), exports);
    __exportStar(require_context(), exports);
    __exportStar(require_event2(), exports);
    __exportStar(require_namespace(), exports);
    var Program = class _Program {
      /**
       * Address of the program.
       */
      get programId() {
        return this._programId;
      }
      /**
       * IDL in camelCase format to work in TypeScript.
       *
       * See {@link rawIdl} field if you need the original IDL.
       */
      get idl() {
        return this._idl;
      }
      /**
       * Raw IDL i.e. the original IDL without camelCase conversion.
       *
       * See {@link idl} field if you need the camelCased version of the IDL.
       */
      get rawIdl() {
        return this._rawIdl;
      }
      /**
       * Coder for serializing requests.
       */
      get coder() {
        return this._coder;
      }
      /**
       * Wallet and network provider.
       */
      get provider() {
        return this._provider;
      }
      /**
       * @param idl       The interface definition.
       * @param provider  The network and wallet context to use. If not provided
       *                  then uses [[getProvider]].
       * @param getCustomResolver A function that returns a custom account resolver
       *                          for the given instruction. This is useful for resolving
       *                          public keys of missing accounts when building instructions
       */
      constructor(idl, provider = (0, provider_js_1.getProvider)(), coder2, getCustomResolver) {
        this._idl = (0, idl_js_1.convertIdlToCamelCase)(idl);
        this._rawIdl = idl;
        this._provider = provider;
        this._programId = (0, common_js_1.translateAddress)(idl.address);
        this._coder = coder2 !== null && coder2 !== void 0 ? coder2 : new index_js_1.BorshCoder(this._idl);
        this._events = new event_js_1.EventManager(this._programId, provider, this._coder);
        const [rpc, instruction, transaction, account, simulate, methods, views] = index_js_2.default.build(this._idl, this._coder, this._programId, provider, getCustomResolver);
        this.rpc = rpc;
        this.instruction = instruction;
        this.transaction = transaction;
        this.account = account;
        this.simulate = simulate;
        this.methods = methods;
        this.views = views;
      }
      /**
       * Generates a Program client by fetching the IDL from the network.
       *
       * In order to use this method, an IDL must have been previously initialized
       * via the anchor CLI's `anchor idl init` command.
       *
       * @param programId The on-chain address of the program.
       * @param provider  The network and wallet context.
       */
      static async at(address, provider) {
        const programId = (0, common_js_1.translateAddress)(address);
        const idl = await _Program.fetchIdl(programId, provider);
        if (!idl) {
          throw new Error(`IDL not found for program: ${address.toString()}`);
        }
        return new _Program(idl, provider);
      }
      /**
       * Fetches an idl from the blockchain.
       *
       * In order to use this method, an IDL must have been previously initialized
       * via the anchor CLI's `anchor idl init` command.
       *
       * @param programId The on-chain address of the program.
       * @param provider  The network and wallet context.
       */
      static async fetchIdl(programAddress, provider) {
        provider = provider !== null && provider !== void 0 ? provider : (0, provider_js_1.getProvider)();
        const programId = (0, common_js_1.translateAddress)(programAddress);
        const idlAddr = (0, idl_js_1.idlAddress)(programId);
        const accountInfo = await provider.connection.getAccountInfo(idlAddr);
        if (!accountInfo)
          return null;
        return (0, idl_js_1.decodeIdlAccount)(accountInfo.data);
      }
      /**
       * Invokes the given callback every time the given event is emitted.
       *
       * @param eventName The PascalCase name of the event, provided by the IDL.
       * @param callback  The function to invoke whenever the event is emitted from
       *                  program logs.
       */
      addEventListener(eventName, callback, commitment) {
        return this._events.addEventListener(eventName, callback, commitment);
      }
      /**
       * Unsubscribes from the given eventName.
       */
      async removeEventListener(listener) {
        return await this._events.removeEventListener(listener);
      }
    };
    exports.Program = Program;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/native/system.js
var require_system2 = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/native/system.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.IDL = exports.coder = exports.program = exports.SYSTEM_PROGRAM_ID = void 0;
    var web3_js_1 = __require("@solana/web3.js");
    var index_js_1 = require_program();
    var index_js_2 = require_system();
    exports.SYSTEM_PROGRAM_ID = new web3_js_1.PublicKey("11111111111111111111111111111111");
    function program(provider) {
      return new index_js_1.Program(exports.IDL, provider, coder2());
    }
    exports.program = program;
    function coder2() {
      return new index_js_2.SystemCoder(exports.IDL);
    }
    exports.coder = coder2;
    exports.IDL = {
      address: "11111111111111111111111111111111",
      metadata: {
        name: "systemProgram",
        version: "0.1.0",
        spec: "0.1.0"
      },
      instructions: [
        {
          name: "advanceNonceAccount",
          discriminator: [4, 0, 0, 0],
          accounts: [
            {
              name: "nonce",
              writable: true
            },
            {
              name: "recentBlockhashes"
            },
            {
              name: "authorized",
              signer: true
            }
          ],
          args: [
            {
              name: "authorized",
              type: "pubkey"
            }
          ]
        },
        {
          name: "allocate",
          discriminator: [8, 0, 0, 0],
          accounts: [
            {
              name: "pubkey",
              writable: true,
              signer: true
            }
          ],
          args: [
            {
              name: "space",
              type: "u64"
            }
          ]
        },
        {
          name: "allocateWithSeed",
          discriminator: [9, 0, 0, 0],
          accounts: [
            {
              name: "account",
              writable: true
            },
            {
              name: "base",
              signer: true
            }
          ],
          args: [
            {
              name: "base",
              type: "pubkey"
            },
            {
              name: "seed",
              type: "string"
            },
            {
              name: "space",
              type: "u64"
            },
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "assign",
          discriminator: [1, 0, 0, 0],
          accounts: [
            {
              name: "pubkey",
              writable: true,
              signer: true
            }
          ],
          args: [
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "assignWithSeed",
          discriminator: [10, 0, 0, 0],
          accounts: [
            {
              name: "account",
              writable: true
            },
            {
              name: "base",
              signer: true
            }
          ],
          args: [
            {
              name: "base",
              type: "pubkey"
            },
            {
              name: "seed",
              type: "string"
            },
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "authorizeNonceAccount",
          discriminator: [7, 0, 0, 0],
          accounts: [
            {
              name: "nonce",
              writable: true
            },
            {
              name: "authorized",
              signer: true
            }
          ],
          args: [
            {
              name: "authorized",
              type: "pubkey"
            }
          ]
        },
        {
          name: "createAccount",
          discriminator: [0, 0, 0, 0],
          accounts: [
            {
              name: "from",
              writable: true,
              signer: true
            },
            {
              name: "to",
              writable: true,
              signer: true
            }
          ],
          args: [
            {
              name: "lamports",
              type: "u64"
            },
            {
              name: "space",
              type: "u64"
            },
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "createAccountWithSeed",
          discriminator: [3, 0, 0, 0],
          accounts: [
            {
              name: "from",
              writable: true,
              signer: true
            },
            {
              name: "to",
              writable: true
            },
            {
              name: "base",
              signer: true
            }
          ],
          args: [
            {
              name: "base",
              type: "pubkey"
            },
            {
              name: "seed",
              type: "string"
            },
            {
              name: "lamports",
              type: "u64"
            },
            {
              name: "space",
              type: "u64"
            },
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "initializeNonceAccount",
          discriminator: [6, 0, 0, 0],
          accounts: [
            {
              name: "nonce",
              writable: true,
              signer: true
            },
            {
              name: "recentBlockhashes"
            },
            {
              name: "rent",
              address: "SysvarRent111111111111111111111111111111111"
            }
          ],
          args: [
            {
              name: "authorized",
              type: "pubkey"
            }
          ]
        },
        {
          name: "transfer",
          discriminator: [2, 0, 0, 0],
          accounts: [
            {
              name: "from",
              writable: true,
              signer: true
            },
            {
              name: "to",
              writable: true
            }
          ],
          args: [
            {
              name: "lamports",
              type: "u64"
            }
          ]
        },
        {
          name: "transferWithSeed",
          discriminator: [11, 0, 0, 0],
          accounts: [
            {
              name: "from",
              writable: true
            },
            {
              name: "base",
              signer: true
            },
            {
              name: "to",
              writable: true
            }
          ],
          args: [
            {
              name: "lamports",
              type: "u64"
            },
            {
              name: "seed",
              type: "string"
            },
            {
              name: "owner",
              type: "pubkey"
            }
          ]
        },
        {
          name: "withdrawNonceAccount",
          discriminator: [5, 0, 0, 0],
          accounts: [
            {
              name: "nonce",
              writable: true
            },
            {
              name: "to",
              writable: true
            },
            {
              name: "recentBlockhashes"
            },
            {
              name: "rent",
              address: "SysvarRent111111111111111111111111111111111"
            },
            {
              name: "authorized",
              signer: true
            }
          ],
          args: [
            {
              name: "lamports",
              type: "u64"
            }
          ]
        }
      ],
      accounts: [
        {
          name: "nonce",
          discriminator: []
        }
      ],
      types: [
        {
          name: "feeCalculator",
          type: {
            kind: "struct",
            fields: [
              {
                name: "lamportsPerSignature",
                type: "u64"
              }
            ]
          }
        },
        {
          name: "nonce",
          type: {
            kind: "struct",
            fields: [
              {
                name: "version",
                type: "u32"
              },
              {
                name: "state",
                type: "u32"
              },
              {
                name: "authorizedPubkey",
                type: "pubkey"
              },
              {
                name: "nonce",
                type: "pubkey"
              },
              {
                name: "feeCalculator",
                type: {
                  defined: {
                    name: "feeCalculator"
                  }
                }
              }
            ]
          }
        }
      ]
    };
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/native/index.js
var require_native = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/native/index.js"(exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Native = void 0;
    var system_js_1 = require_system2();
    var Native = class {
      static system(provider) {
        return (0, system_js_1.program)(provider);
      }
    };
    exports.Native = Native;
  }
});

// sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/lib/parser.js
var require_parser = __commonJS({
  "sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/lib/parser.js"(exports, module) {
    "use strict";
    var peg$SyntaxError = class extends SyntaxError {
      constructor(message, expected, found, location) {
        super(message);
        this.expected = expected;
        this.found = found;
        this.location = location;
        this.name = "SyntaxError";
      }
      format(sources) {
        let str = "Error: " + this.message;
        if (this.location) {
          let src = null;
          const st = sources.find((s2) => s2.source === this.location.source);
          if (st) {
            src = st.text.split(/\r\n|\n|\r/g);
          }
          const s = this.location.start;
          const offset_s = this.location.source && typeof this.location.source.offset === "function" ? this.location.source.offset(s) : s;
          const loc = this.location.source + ":" + offset_s.line + ":" + offset_s.column;
          if (src) {
            const e = this.location.end;
            const filler = "".padEnd(offset_s.line.toString().length, " ");
            const line = src[s.line - 1];
            const last = s.line === e.line ? e.column : line.length + 1;
            const hatLen = last - s.column || 1;
            str += "\n --> " + loc + "\n" + filler + " |\n" + offset_s.line + " | " + line + "\n" + filler + " | " + "".padEnd(s.column - 1, " ") + "".padEnd(hatLen, "^");
          } else {
            str += "\n at " + loc;
          }
        }
        return str;
      }
      static buildMessage(expected, found) {
        function hex(ch) {
          return ch.codePointAt(0).toString(16).toUpperCase();
        }
        const nonPrintable = Object.prototype.hasOwnProperty.call(RegExp.prototype, "unicode") ? new RegExp("[\\p{C}\\p{Mn}\\p{Mc}]", "gu") : null;
        function unicodeEscape(s) {
          if (nonPrintable) {
            return s.replace(nonPrintable, (ch) => "\\u{" + hex(ch) + "}");
          }
          return s;
        }
        function literalEscape(s) {
          return unicodeEscape(s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\0/g, "\\0").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\x00-\x0F]/g, (ch) => "\\x0" + hex(ch)).replace(/[\x10-\x1F\x7F-\x9F]/g, (ch) => "\\x" + hex(ch)));
        }
        function classEscape(s) {
          return unicodeEscape(s.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\^/g, "\\^").replace(/-/g, "\\-").replace(/\0/g, "\\0").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\x00-\x0F]/g, (ch) => "\\x0" + hex(ch)).replace(/[\x10-\x1F\x7F-\x9F]/g, (ch) => "\\x" + hex(ch)));
        }
        const DESCRIBE_EXPECTATION_FNS = {
          literal(expectation) {
            return '"' + literalEscape(expectation.text) + '"';
          },
          class(expectation) {
            const escapedParts = expectation.parts.map(
              (part) => Array.isArray(part) ? classEscape(part[0]) + "-" + classEscape(part[1]) : classEscape(part)
            );
            return "[" + (expectation.inverted ? "^" : "") + escapedParts.join("") + "]" + (expectation.unicode ? "u" : "");
          },
          any() {
            return "any character";
          },
          end() {
            return "end of input";
          },
          other(expectation) {
            return expectation.description;
          }
        };
        function describeExpectation(expectation) {
          return DESCRIBE_EXPECTATION_FNS[expectation.type](expectation);
        }
        function describeExpected(expected2) {
          const descriptions = expected2.map(describeExpectation);
          descriptions.sort();
          if (descriptions.length > 0) {
            let j = 1;
            for (let i = 1; i < descriptions.length; i++) {
              if (descriptions[i - 1] !== descriptions[i]) {
                descriptions[j] = descriptions[i];
                j++;
              }
            }
            descriptions.length = j;
          }
          switch (descriptions.length) {
            case 1:
              return descriptions[0];
            case 2:
              return descriptions[0] + " or " + descriptions[1];
            default:
              return descriptions.slice(0, -1).join(", ") + ", or " + descriptions[descriptions.length - 1];
          }
        }
        function describeFound(found2) {
          return found2 ? '"' + literalEscape(found2) + '"' : "end of input";
        }
        return "Expected " + describeExpected(expected) + " but " + describeFound(found) + " found.";
      }
    };
    function peg$parse(input, options) {
      options = options !== void 0 ? options : {};
      const peg$FAILED = {};
      const peg$source = options.grammarSource;
      const peg$startRuleFunctions = {
        start: peg$parsestart
      };
      let peg$startRuleFunction = peg$parsestart;
      const peg$c0 = "#";
      const peg$c1 = "[";
      const peg$c2 = "]";
      const peg$c3 = ".";
      const peg$c4 = "=";
      const peg$c5 = "inf";
      const peg$c6 = "nan";
      const peg$c7 = '"""';
      const peg$c8 = '"';
      const peg$c9 = "'''";
      const peg$c10 = "'";
      const peg$c11 = "\\";
      const peg$c12 = "\r\n";
      const peg$c13 = '""';
      const peg$c14 = "''";
      const peg$c15 = "0";
      const peg$c16 = "0x";
      const peg$c17 = "0o";
      const peg$c18 = "0b";
      const peg$c19 = "true";
      const peg$c20 = "false";
      const peg$c21 = ",";
      const peg$c22 = "{";
      const peg$c23 = "}";
      const peg$c24 = "-";
      const peg$c25 = ":";
      const peg$c26 = "z";
      const peg$c27 = "t";
      const peg$c28 = " ";
      const peg$c29 = "\n";
      const peg$c30 = "\r";
      const peg$c31 = "\uFEFF";
      const peg$c32 = "\\U";
      const peg$c33 = "\\u";
      const peg$c34 = "\\x";
      const peg$r0 = /^[\t -~\x80-\uFFFF]/;
      const peg$r1 = /^[+\-]/;
      const peg$r2 = /^[^"\\\0-\b\v-\x1F\x7F\r]/;
      const peg$r3 = /^[^'\0-\b\v-\x1F\x7F\r]/;
      const peg$r4 = /^[^"\\\0-\b\n-\x1F\x7F]/;
      const peg$r5 = /^[^'\0-\b\n-\x1F\x7F]/;
      const peg$r6 = /^[eE]/;
      const peg$r7 = /^[0-9_]/;
      const peg$r8 = /^[1-9]/;
      const peg$r9 = /^[_]/;
      const peg$r10 = /^[0-9]/;
      const peg$r11 = /^[0-9a-fA-F]/;
      const peg$r12 = /^[0-7]/;
      const peg$r13 = /^[01]/;
      const peg$r14 = /^[ \t]/;
      const peg$r15 = /^[A-Za-z0-9_\-]/;
      const peg$r16 = /^["\\btnfre]/;
      const peg$e0 = peg$literalExpectation("#", false);
      const peg$e1 = peg$classExpectation(["	", [" ", "~"], ["\x80", "\uFFFF"]], false, false, false);
      const peg$e2 = peg$literalExpectation("[", false);
      const peg$e3 = peg$literalExpectation("]", false);
      const peg$e4 = peg$literalExpectation(".", false);
      const peg$e5 = peg$literalExpectation("=", false);
      const peg$e6 = peg$classExpectation(["+", "-"], false, false, false);
      const peg$e7 = peg$literalExpectation("inf", false);
      const peg$e8 = peg$literalExpectation("nan", false);
      const peg$e9 = peg$literalExpectation('"""', false);
      const peg$e10 = peg$literalExpectation('"', false);
      const peg$e11 = peg$literalExpectation("'''", false);
      const peg$e12 = peg$literalExpectation("'", false);
      const peg$e13 = peg$literalExpectation("\\", false);
      const peg$e14 = peg$anyExpectation();
      const peg$e15 = peg$literalExpectation("\r\n", false);
      const peg$e16 = peg$classExpectation(['"', "\\", ["\0", "\b"], ["\v", ""], "\x7F", "\r"], true, false, false);
      const peg$e17 = peg$literalExpectation('""', false);
      const peg$e18 = peg$classExpectation(["'", ["\0", "\b"], ["\v", ""], "\x7F", "\r"], true, false, false);
      const peg$e19 = peg$literalExpectation("''", false);
      const peg$e20 = peg$classExpectation(['"', "\\", ["\0", "\b"], ["\n", ""], "\x7F"], true, false, false);
      const peg$e21 = peg$classExpectation(["'", ["\0", "\b"], ["\n", ""], "\x7F"], true, false, false);
      const peg$e22 = peg$classExpectation(["e", "E"], false, false, false);
      const peg$e23 = peg$literalExpectation("0", false);
      const peg$e24 = peg$literalExpectation("0x", false);
      const peg$e25 = peg$literalExpectation("0o", false);
      const peg$e26 = peg$literalExpectation("0b", false);
      const peg$e27 = peg$classExpectation([["0", "9"], "_"], false, false, false);
      const peg$e28 = peg$classExpectation([["1", "9"]], false, false, false);
      const peg$e29 = peg$classExpectation(["_"], false, false, false);
      const peg$e30 = peg$classExpectation([["0", "9"]], false, false, false);
      const peg$e31 = peg$classExpectation([["0", "9"], ["a", "f"], ["A", "F"]], false, false, false);
      const peg$e32 = peg$classExpectation([["0", "7"]], false, false, false);
      const peg$e33 = peg$classExpectation(["0", "1"], false, false, false);
      const peg$e34 = peg$literalExpectation("true", false);
      const peg$e35 = peg$literalExpectation("false", false);
      const peg$e36 = peg$literalExpectation(",", false);
      const peg$e37 = peg$literalExpectation("{", false);
      const peg$e38 = peg$literalExpectation("}", false);
      const peg$e39 = peg$literalExpectation("-", false);
      const peg$e40 = peg$literalExpectation(":", false);
      const peg$e41 = peg$literalExpectation("Z", true);
      const peg$e42 = peg$literalExpectation("T", true);
      const peg$e43 = peg$literalExpectation(" ", false);
      const peg$e44 = peg$classExpectation([" ", "	"], false, false, false);
      const peg$e45 = peg$literalExpectation("\n", false);
      const peg$e46 = peg$literalExpectation("\r", false);
      const peg$e47 = peg$literalExpectation("\uFEFF", false);
      const peg$e48 = peg$classExpectation([["A", "Z"], ["a", "z"], ["0", "9"], "_", "-"], false, false, false);
      const peg$e49 = peg$classExpectation(['"', "\\", "b", "t", "n", "f", "r", "e"], false, false, false);
      const peg$e50 = peg$literalExpectation("\\U", false);
      const peg$e51 = peg$literalExpectation("\\u", false);
      const peg$e52 = peg$literalExpectation("\\x", false);
      function peg$f0() {
        return nodes;
      }
      function peg$f1(name) {
        addNode(node("ArrayPath", name, offset()));
      }
      function peg$f2(name) {
        addNode(node("ObjectPath", name, offset()));
      }
      function peg$f3(parts, name) {
        return parts.concat(name);
      }
      function peg$f4(name) {
        return [name];
      }
      function peg$f5(name) {
        return name;
      }
      function peg$f6(name) {
        return name;
      }
      function peg$f7(keys, value) {
        addNode(node("Assign", value, offset(), keys));
      }
      function peg$f8(node2) {
        return node2.value;
      }
      function peg$f9(node2) {
        return node2.value;
      }
      function peg$f10() {
        if (++depth > MAX_DEPTH) {
          depth--;
          genError("Maximum nesting depth of " + MAX_DEPTH + " exceeded.", offset());
        }
        return true;
      }
      function peg$f11(v) {
        return v;
      }
      function peg$f12(v) {
        depth--;
        return v;
      }
      function peg$f13() {
        depth--;
        return false;
      }
      function peg$f14(sign) {
        return node("Float", sign === "-" ? -Infinity : Infinity, offset());
      }
      function peg$f15(sign) {
        return node("Float", NaN, offset());
      }
      function peg$f16(body) {
        return node("String", body, offset());
      }
      function peg$f17(chars) {
        return node("String", chars.join(""), offset());
      }
      function peg$f18(body) {
        return node("String", body, offset());
      }
      function peg$f19(chars) {
        return node("String", chars.join(""), offset());
      }
      function peg$f20(head, parts, tail) {
        var result = head.join("");
        for (var i = 0; i < parts.length; i++) {
          result += parts[i][0] + parts[i][1].join("");
        }
        return result + (tail || "");
      }
      function peg$f21() {
        genError("Invalid escape sequence", offset());
      }
      function peg$f22() {
        return "\n";
      }
      function peg$f23() {
        return "";
      }
      function peg$f24() {
        return '""';
      }
      function peg$f25() {
        return '"';
      }
      function peg$f26() {
        return '""';
      }
      function peg$f27() {
        return '"';
      }
      function peg$f28(head, parts, tail) {
        var result = head.join("");
        for (var i = 0; i < parts.length; i++) {
          result += parts[i][0] + parts[i][1].join("");
        }
        return result + (tail || "");
      }
      function peg$f29() {
        return "\n";
      }
      function peg$f30() {
        return "''";
      }
      function peg$f31() {
        return "'";
      }
      function peg$f32() {
        return "''";
      }
      function peg$f33() {
        return "'";
      }
      function peg$f34() {
        genError("Invalid escape sequence", offset());
      }
      function peg$f35(left, right) {
        return node("Float", parseFloat(stripUnderscores(left + "e" + right)), offset());
      }
      function peg$f36(text2) {
        return node("Float", parseFloat(stripUnderscores(text2)), offset());
      }
      function peg$f37(sign, digits, frac) {
        return (sign === "-" ? "-" : "") + digits + "." + frac;
      }
      function peg$f38(sign, digits, frac) {
        return (sign === "-" ? "-" : "") + digits + "." + frac;
      }
      function peg$f39(sign, digits) {
        return (sign === "-" ? "-" : "") + digits;
      }
      function peg$f40() {
        return "0";
      }
      function peg$f41(sign, digits) {
        return (sign || "") + digits;
      }
      function peg$f42(digits) {
        return node("Integer", parseInt(stripUnderscores(digits), 16), offset());
      }
      function peg$f43(digits) {
        return node("Integer", parseInt(stripUnderscores(digits), 8), offset());
      }
      function peg$f44(digits) {
        return node("Integer", parseInt(stripUnderscores(digits), 2), offset());
      }
      function peg$f45(text2) {
        return node("Integer", parseInt(stripUnderscores(text2), 10), offset());
      }
      function peg$f46(sign) {
        return (sign || "") + "0";
      }
      function peg$f47(sign, digits) {
        return (sign || "") + digits;
      }
      function peg$f48() {
        return node("Boolean", true, offset());
      }
      function peg$f49() {
        return node("Boolean", false, offset());
      }
      function peg$f50() {
        return node("Array", [], offset());
      }
      function peg$f51(head, v) {
        return v;
      }
      function peg$f52(head, tail) {
        tail.unshift(head);
        return node("Array", tail, offset());
      }
      function peg$f53() {
        return node("InlineTable", [], offset());
      }
      function peg$f54(head, e) {
        return e;
      }
      function peg$f55(head, tail) {
        tail.unshift(head);
        return node("InlineTable", tail, offset());
      }
      function peg$f56(keys, value) {
        return node("InlineTableValue", value, offset(), keys);
      }
      function peg$f57(parts, last) {
        return parts.concat(last);
      }
      function peg$f58(k) {
        return [k];
      }
      function peg$f59(k) {
        return k;
      }
      function peg$f60(t, frac) {
        return frac ? t + frac : t;
      }
      function peg$f61(t) {
        return t + ":00";
      }
      function peg$f62() {
        return "Z";
      }
      function peg$f63(d, t, o) {
        var off = offset();
        validateDate(d, off);
        validateTime(t, off);
        validateOffset(o, off);
        return node("Date", /* @__PURE__ */ new Date(d + "T" + t + o), off);
      }
      function peg$f64(d, t) {
        var off = offset();
        validateDate(d, off);
        validateTime(t, off);
        return node("LocalDateTime", d + "T" + t, off);
      }
      function peg$f65(d) {
        var off = offset();
        validateDate(d, off);
        return node("LocalDate", d, off);
      }
      function peg$f66(t) {
        var off = offset();
        validateTime(t, off);
        return node("LocalTime", t, off);
      }
      function peg$f67(ch) {
        return ch === "n" ? "\n" : ch === "t" ? "	" : ch === "r" ? "\r" : ch === "\\" ? "\\" : ch === '"' ? '"' : ch === "b" ? "\b" : ch === "f" ? "\f" : "\x1B";
      }
      function peg$f68(digits) {
        return convertCodePoint(digits);
      }
      function peg$f69(digits) {
        return convertCodePoint(digits);
      }
      function peg$f70(digits) {
        return convertCodePoint(digits);
      }
      let peg$currPos = options.peg$currPos | 0;
      let peg$savedPos = peg$currPos;
      const peg$posDetailsCache = [{ line: 1, column: 1 }];
      let peg$maxFailPos = peg$currPos;
      let peg$maxFailExpected = options.peg$maxFailExpected || [];
      let peg$silentFails = options.peg$silentFails | 0;
      let peg$result;
      if (options.startRule) {
        if (!(options.startRule in peg$startRuleFunctions)) {
          throw new Error(`Can't start parsing from rule "` + options.startRule + '".');
        }
        peg$startRuleFunction = peg$startRuleFunctions[options.startRule];
      }
      function text() {
        return input.substring(peg$savedPos, peg$currPos);
      }
      function offset() {
        return peg$savedPos;
      }
      function range() {
        return {
          source: peg$source,
          start: peg$savedPos,
          end: peg$currPos
        };
      }
      function location() {
        return peg$computeLocation(peg$savedPos, peg$currPos);
      }
      function expected(description, location2) {
        location2 = location2 !== void 0 ? location2 : peg$computeLocation(peg$savedPos, peg$currPos);
        throw peg$buildStructuredError(
          [peg$otherExpectation(description)],
          input.substring(peg$savedPos, peg$currPos),
          location2
        );
      }
      function error(message, location2) {
        location2 = location2 !== void 0 ? location2 : peg$computeLocation(peg$savedPos, peg$currPos);
        throw peg$buildSimpleError(message, location2);
      }
      function peg$getUnicode(pos = peg$currPos) {
        const cp = input.codePointAt(pos);
        if (cp === void 0) {
          return "";
        }
        return String.fromCodePoint(cp);
      }
      function peg$literalExpectation(text2, ignoreCase) {
        return { type: "literal", text: text2, ignoreCase };
      }
      function peg$classExpectation(parts, inverted, ignoreCase, unicode) {
        return { type: "class", parts, inverted, ignoreCase, unicode };
      }
      function peg$anyExpectation() {
        return { type: "any" };
      }
      function peg$endExpectation() {
        return { type: "end" };
      }
      function peg$otherExpectation(description) {
        return { type: "other", description };
      }
      function peg$computePosDetails(pos) {
        let details = peg$posDetailsCache[pos];
        let p;
        if (details) {
          return details;
        } else {
          if (pos >= peg$posDetailsCache.length) {
            p = peg$posDetailsCache.length - 1;
          } else {
            p = pos;
            while (!peg$posDetailsCache[--p]) {
            }
          }
          details = peg$posDetailsCache[p];
          details = {
            line: details.line,
            column: details.column
          };
          while (p < pos) {
            if (input.charCodeAt(p) === 10) {
              details.line++;
              details.column = 1;
            } else {
              details.column++;
            }
            p++;
          }
          peg$posDetailsCache[pos] = details;
          return details;
        }
      }
      function peg$computeLocation(startPos, endPos, offset2) {
        const startPosDetails = peg$computePosDetails(startPos);
        const endPosDetails = peg$computePosDetails(endPos);
        const res = {
          source: peg$source,
          start: {
            offset: startPos,
            line: startPosDetails.line,
            column: startPosDetails.column
          },
          end: {
            offset: endPos,
            line: endPosDetails.line,
            column: endPosDetails.column
          }
        };
        if (offset2 && peg$source && typeof peg$source.offset === "function") {
          res.start = peg$source.offset(res.start);
          res.end = peg$source.offset(res.end);
        }
        return res;
      }
      function peg$fail(expected2) {
        if (peg$currPos < peg$maxFailPos) {
          return;
        }
        if (peg$currPos > peg$maxFailPos) {
          peg$maxFailPos = peg$currPos;
          peg$maxFailExpected = [];
        }
        peg$maxFailExpected.push(expected2);
      }
      function peg$buildSimpleError(message, location2) {
        return new peg$SyntaxError(message, null, null, location2);
      }
      function peg$buildStructuredError(expected2, found, location2) {
        return new peg$SyntaxError(
          peg$SyntaxError.buildMessage(expected2, found),
          expected2,
          found,
          location2
        );
      }
      function peg$parsestart() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        s1 = peg$parseBOM();
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        s2 = [];
        s3 = peg$parseline();
        while (s3 !== peg$FAILED) {
          s2.push(s3);
          s3 = peg$parseline();
        }
        peg$savedPos = s0;
        s0 = peg$f0();
        return s0;
      }
      function peg$parseline() {
        let s0, s1, s2, s3, s4, s5, s6;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseS();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parseS();
        }
        s2 = peg$parseexpression();
        if (s2 !== peg$FAILED) {
          s3 = [];
          s4 = peg$parseS();
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = peg$parseS();
          }
          s4 = peg$parsecomment();
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = [];
          s6 = peg$parseNL();
          if (s6 !== peg$FAILED) {
            while (s6 !== peg$FAILED) {
              s5.push(s6);
              s6 = peg$parseNL();
            }
          } else {
            s5 = peg$FAILED;
          }
          if (s5 === peg$FAILED) {
            s5 = peg$parseEOF();
          }
          if (s5 !== peg$FAILED) {
            s1 = [s1, s2, s3, s4, s5];
            s0 = s1;
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = [];
          s2 = peg$parseS();
          if (s2 !== peg$FAILED) {
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = peg$parseS();
            }
          } else {
            s1 = peg$FAILED;
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseNL();
            if (s3 !== peg$FAILED) {
              while (s3 !== peg$FAILED) {
                s2.push(s3);
                s3 = peg$parseNL();
              }
            } else {
              s2 = peg$FAILED;
            }
            if (s2 === peg$FAILED) {
              s2 = peg$parseEOF();
            }
            if (s2 !== peg$FAILED) {
              s1 = [s1, s2];
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$parseNL();
          }
        }
        return s0;
      }
      function peg$parseexpression() {
        let s0;
        s0 = peg$parsecomment();
        if (s0 === peg$FAILED) {
          s0 = peg$parsetable_or_array_path();
          if (s0 === peg$FAILED) {
            s0 = peg$parseassignment();
          }
        }
        return s0;
      }
      function peg$parsecomment() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 35) {
          s1 = peg$c0;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e0);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = input.charAt(peg$currPos);
          if (peg$r0.test(s3)) {
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e1);
            }
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = input.charAt(peg$currPos);
            if (peg$r0.test(s3)) {
              peg$currPos++;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e1);
              }
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsetable_or_array_path() {
        let s0, s1, s2, s3, s4, s5, s6, s7;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 91) {
          s1 = peg$c1;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e2);
          }
        }
        if (s1 !== peg$FAILED) {
          if (input.charCodeAt(peg$currPos) === 91) {
            s2 = peg$c1;
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e2);
            }
          }
          if (s2 !== peg$FAILED) {
            s3 = [];
            s4 = peg$parseS();
            while (s4 !== peg$FAILED) {
              s3.push(s4);
              s4 = peg$parseS();
            }
            s4 = peg$parsetable_key();
            if (s4 !== peg$FAILED) {
              s5 = [];
              s6 = peg$parseS();
              while (s6 !== peg$FAILED) {
                s5.push(s6);
                s6 = peg$parseS();
              }
              if (input.charCodeAt(peg$currPos) === 93) {
                s6 = peg$c2;
                peg$currPos++;
              } else {
                s6 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e3);
                }
              }
              if (s6 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 93) {
                  s7 = peg$c2;
                  peg$currPos++;
                } else {
                  s7 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e3);
                  }
                }
                if (s7 !== peg$FAILED) {
                  peg$savedPos = s0;
                  s0 = peg$f1(s4);
                } else {
                  peg$currPos = s0;
                  s0 = peg$FAILED;
                }
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 91) {
            s1 = peg$c1;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e2);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseS();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseS();
            }
            s3 = peg$parsetable_key();
            if (s3 !== peg$FAILED) {
              s4 = [];
              s5 = peg$parseS();
              while (s5 !== peg$FAILED) {
                s4.push(s5);
                s5 = peg$parseS();
              }
              if (input.charCodeAt(peg$currPos) === 93) {
                s5 = peg$c2;
                peg$currPos++;
              } else {
                s5 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e3);
                }
              }
              if (s5 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f2(s3);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsetable_key() {
        let s0, s1, s2;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parsedot_ended_table_key_part();
        if (s2 !== peg$FAILED) {
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parsedot_ended_table_key_part();
          }
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$parsetable_key_part();
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f3(s1, s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parsetable_key_part();
          if (s1 !== peg$FAILED) {
            peg$savedPos = s0;
            s1 = peg$f4(s1);
          }
          s0 = s1;
        }
        return s0;
      }
      function peg$parsetable_key_part() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseS();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parseS();
        }
        s2 = peg$parsesimple_key();
        if (s2 !== peg$FAILED) {
          s3 = [];
          s4 = peg$parseS();
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = peg$parseS();
          }
          peg$savedPos = s0;
          s0 = peg$f5(s2);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsedot_ended_table_key_part() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseS();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parseS();
        }
        s2 = peg$parsesimple_key();
        if (s2 !== peg$FAILED) {
          s3 = [];
          s4 = peg$parseS();
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = peg$parseS();
          }
          if (input.charCodeAt(peg$currPos) === 46) {
            s4 = peg$c3;
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e4);
            }
          }
          if (s4 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f6(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseassignment() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = peg$parseinline_key();
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseS();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseS();
          }
          if (input.charCodeAt(peg$currPos) === 61) {
            s3 = peg$c4;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e5);
            }
          }
          if (s3 !== peg$FAILED) {
            s4 = [];
            s5 = peg$parseS();
            while (s5 !== peg$FAILED) {
              s4.push(s5);
              s5 = peg$parseS();
            }
            s5 = peg$parsevalue();
            if (s5 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f7(s1, s5);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsekey() {
        let s0, s1, s2;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseASCII_BASIC();
        if (s2 !== peg$FAILED) {
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseASCII_BASIC();
          }
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        return s0;
      }
      function peg$parsequoted_key() {
        let s0, s1;
        s0 = peg$currPos;
        s1 = peg$parsedouble_quoted_single_line_string();
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f8(s1);
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parsesingle_quoted_single_line_string();
          if (s1 !== peg$FAILED) {
            peg$savedPos = s0;
            s1 = peg$f9(s1);
          }
          s0 = s1;
        }
        return s0;
      }
      function peg$parsevalue() {
        let s0, s1, s2;
        s0 = peg$currPos;
        peg$savedPos = peg$currPos;
        s1 = peg$f10();
        if (s1) {
          s1 = void 0;
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$parsevalue_choice();
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f11(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsevalue_choice() {
        let s0, s1;
        s0 = peg$currPos;
        s1 = peg$parsevalue_body();
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f12(s1);
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          peg$savedPos = peg$currPos;
          s0 = peg$f13();
          if (s0) {
            s0 = void 0;
          } else {
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsevalue_body() {
        let s0;
        s0 = peg$parsestring();
        if (s0 === peg$FAILED) {
          s0 = peg$parsenumber_or_date();
          if (s0 === peg$FAILED) {
            s0 = peg$parseboolean();
            if (s0 === peg$FAILED) {
              s0 = peg$parsearray();
              if (s0 === peg$FAILED) {
                s0 = peg$parseinline_table();
              }
            }
          }
        }
        return s0;
      }
      function peg$parsenumber_or_date() {
        let s0, s1, s2;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r1.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e6);
          }
        }
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        if (input.substr(peg$currPos, 3) === peg$c5) {
          s2 = peg$c5;
          peg$currPos += 3;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e7);
          }
        }
        if (s2 !== peg$FAILED) {
          peg$savedPos = s0;
          s0 = peg$f14(s1);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = input.charAt(peg$currPos);
          if (peg$r1.test(s1)) {
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e6);
            }
          }
          if (s1 === peg$FAILED) {
            s1 = null;
          }
          if (input.substr(peg$currPos, 3) === peg$c6) {
            s2 = peg$c6;
            peg$currPos += 3;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e8);
            }
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f15(s1);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$parsedatetime();
            if (s0 === peg$FAILED) {
              s0 = peg$parsefloat();
              if (s0 === peg$FAILED) {
                s0 = peg$parseinteger();
              }
            }
          }
        }
        return s0;
      }
      function peg$parsestring() {
        let s0;
        s0 = peg$parsedouble_quoted_multiline_string();
        if (s0 === peg$FAILED) {
          s0 = peg$parsedouble_quoted_single_line_string();
          if (s0 === peg$FAILED) {
            s0 = peg$parsesingle_quoted_multiline_string();
            if (s0 === peg$FAILED) {
              s0 = peg$parsesingle_quoted_single_line_string();
            }
          }
        }
        return s0;
      }
      function peg$parsedouble_quoted_multiline_string() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 3) === peg$c7) {
          s1 = peg$c7;
          peg$currPos += 3;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e9);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$parseNL();
          if (s2 === peg$FAILED) {
            s2 = null;
          }
          s3 = peg$parsemlb_body();
          if (input.substr(peg$currPos, 3) === peg$c7) {
            s4 = peg$c7;
            peg$currPos += 3;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e9);
            }
          }
          if (s4 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f16(s3);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsedouble_quoted_single_line_string() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 34) {
          s1 = peg$c8;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e10);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parsestring_char();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parsestring_char();
          }
          if (input.charCodeAt(peg$currPos) === 34) {
            s3 = peg$c8;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e10);
            }
          }
          if (s3 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f17(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsesingle_quoted_multiline_string() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 3) === peg$c9) {
          s1 = peg$c9;
          peg$currPos += 3;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e11);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$parseNL();
          if (s2 === peg$FAILED) {
            s2 = null;
          }
          s3 = peg$parsemll_body();
          if (input.substr(peg$currPos, 3) === peg$c9) {
            s4 = peg$c9;
            peg$currPos += 3;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e11);
            }
          }
          if (s4 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f18(s3);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsesingle_quoted_single_line_string() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 39) {
          s1 = peg$c10;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e12);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseliteral_char();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseliteral_char();
          }
          if (input.charCodeAt(peg$currPos) === 39) {
            s3 = peg$c10;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e12);
            }
          }
          if (s3 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f19(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsemlb_body() {
        let s0, s1, s2, s3, s4, s5, s6;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parsemlb_content();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parsemlb_content();
        }
        s2 = [];
        s3 = peg$currPos;
        s4 = peg$parsemlb_quotes();
        if (s4 !== peg$FAILED) {
          s5 = [];
          s6 = peg$parsemlb_content();
          if (s6 !== peg$FAILED) {
            while (s6 !== peg$FAILED) {
              s5.push(s6);
              s6 = peg$parsemlb_content();
            }
          } else {
            s5 = peg$FAILED;
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
        } else {
          peg$currPos = s3;
          s3 = peg$FAILED;
        }
        while (s3 !== peg$FAILED) {
          s2.push(s3);
          s3 = peg$currPos;
          s4 = peg$parsemlb_quotes();
          if (s4 !== peg$FAILED) {
            s5 = [];
            s6 = peg$parsemlb_content();
            if (s6 !== peg$FAILED) {
              while (s6 !== peg$FAILED) {
                s5.push(s6);
                s6 = peg$parsemlb_content();
              }
            } else {
              s5 = peg$FAILED;
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
        }
        s3 = peg$parsemlb_trailing();
        if (s3 === peg$FAILED) {
          s3 = null;
        }
        peg$savedPos = s0;
        s0 = peg$f20(s1, s2, s3);
        return s0;
      }
      function peg$parsemlb_content() {
        let s0, s1, s2;
        s0 = peg$parseESCAPED();
        if (s0 === peg$FAILED) {
          s0 = peg$parsemlb_escaped_newline();
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.charCodeAt(peg$currPos) === 92) {
              s1 = peg$c11;
              peg$currPos++;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e13);
              }
            }
            if (s1 !== peg$FAILED) {
              if (input.length > peg$currPos) {
                s2 = input.charAt(peg$currPos);
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e14);
                }
              }
              if (s2 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f21();
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              if (input.substr(peg$currPos, 2) === peg$c12) {
                s1 = peg$c12;
                peg$currPos += 2;
              } else {
                s1 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e15);
                }
              }
              if (s1 !== peg$FAILED) {
                peg$savedPos = s0;
                s1 = peg$f22();
              }
              s0 = s1;
              if (s0 === peg$FAILED) {
                s0 = peg$currPos;
                s1 = [];
                s2 = input.charAt(peg$currPos);
                if (peg$r2.test(s2)) {
                  peg$currPos++;
                } else {
                  s2 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e16);
                  }
                }
                if (s2 !== peg$FAILED) {
                  while (s2 !== peg$FAILED) {
                    s1.push(s2);
                    s2 = input.charAt(peg$currPos);
                    if (peg$r2.test(s2)) {
                      peg$currPos++;
                    } else {
                      s2 = peg$FAILED;
                      if (peg$silentFails === 0) {
                        peg$fail(peg$e16);
                      }
                    }
                  }
                } else {
                  s1 = peg$FAILED;
                }
                if (s1 !== peg$FAILED) {
                  s0 = input.substring(s0, peg$currPos);
                } else {
                  s0 = s1;
                }
              }
            }
          }
        }
        return s0;
      }
      function peg$parsemlb_escaped_newline() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 92) {
          s1 = peg$c11;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e13);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseS();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseS();
          }
          s3 = peg$parseNL();
          if (s3 !== peg$FAILED) {
            s4 = [];
            s5 = peg$parseNLS();
            while (s5 !== peg$FAILED) {
              s4.push(s5);
              s5 = peg$parseNLS();
            }
            peg$savedPos = s0;
            s0 = peg$f23();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsemlb_quotes() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c13) {
          s1 = peg$c13;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e17);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          peg$silentFails++;
          if (input.charCodeAt(peg$currPos) === 34) {
            s3 = peg$c8;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e10);
            }
          }
          peg$silentFails--;
          if (s3 === peg$FAILED) {
            s2 = void 0;
          } else {
            peg$currPos = s2;
            s2 = peg$FAILED;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f24();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 34) {
            s1 = peg$c8;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e10);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 34) {
              s3 = peg$c8;
              peg$currPos++;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e10);
              }
            }
            peg$silentFails--;
            if (s3 === peg$FAILED) {
              s2 = void 0;
            } else {
              peg$currPos = s2;
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f25();
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsemlb_trailing() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c13) {
          s1 = peg$c13;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e17);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          peg$silentFails++;
          if (input.substr(peg$currPos, 3) === peg$c7) {
            s3 = peg$c7;
            peg$currPos += 3;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e9);
            }
          }
          peg$silentFails--;
          if (s3 !== peg$FAILED) {
            peg$currPos = s2;
            s2 = void 0;
          } else {
            s2 = peg$FAILED;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f26();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 34) {
            s1 = peg$c8;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e10);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            if (input.substr(peg$currPos, 3) === peg$c7) {
              s3 = peg$c7;
              peg$currPos += 3;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e9);
              }
            }
            peg$silentFails--;
            if (s3 !== peg$FAILED) {
              peg$currPos = s2;
              s2 = void 0;
            } else {
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f27();
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsemll_body() {
        let s0, s1, s2, s3, s4, s5, s6;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parsemll_content();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parsemll_content();
        }
        s2 = [];
        s3 = peg$currPos;
        s4 = peg$parsemll_quotes();
        if (s4 !== peg$FAILED) {
          s5 = [];
          s6 = peg$parsemll_content();
          if (s6 !== peg$FAILED) {
            while (s6 !== peg$FAILED) {
              s5.push(s6);
              s6 = peg$parsemll_content();
            }
          } else {
            s5 = peg$FAILED;
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
        } else {
          peg$currPos = s3;
          s3 = peg$FAILED;
        }
        while (s3 !== peg$FAILED) {
          s2.push(s3);
          s3 = peg$currPos;
          s4 = peg$parsemll_quotes();
          if (s4 !== peg$FAILED) {
            s5 = [];
            s6 = peg$parsemll_content();
            if (s6 !== peg$FAILED) {
              while (s6 !== peg$FAILED) {
                s5.push(s6);
                s6 = peg$parsemll_content();
              }
            } else {
              s5 = peg$FAILED;
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
        }
        s3 = peg$parsemll_trailing();
        if (s3 === peg$FAILED) {
          s3 = null;
        }
        peg$savedPos = s0;
        s0 = peg$f28(s1, s2, s3);
        return s0;
      }
      function peg$parsemll_content() {
        let s0, s1, s2;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c12) {
          s1 = peg$c12;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e15);
          }
        }
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f29();
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = [];
          s2 = input.charAt(peg$currPos);
          if (peg$r3.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e18);
            }
          }
          if (s2 !== peg$FAILED) {
            while (s2 !== peg$FAILED) {
              s1.push(s2);
              s2 = input.charAt(peg$currPos);
              if (peg$r3.test(s2)) {
                peg$currPos++;
              } else {
                s2 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e18);
                }
              }
            }
          } else {
            s1 = peg$FAILED;
          }
          if (s1 !== peg$FAILED) {
            s0 = input.substring(s0, peg$currPos);
          } else {
            s0 = s1;
          }
        }
        return s0;
      }
      function peg$parsemll_quotes() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c14) {
          s1 = peg$c14;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e19);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          peg$silentFails++;
          if (input.charCodeAt(peg$currPos) === 39) {
            s3 = peg$c10;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e12);
            }
          }
          peg$silentFails--;
          if (s3 === peg$FAILED) {
            s2 = void 0;
          } else {
            peg$currPos = s2;
            s2 = peg$FAILED;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f30();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 39) {
            s1 = peg$c10;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e12);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 39) {
              s3 = peg$c10;
              peg$currPos++;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e12);
              }
            }
            peg$silentFails--;
            if (s3 === peg$FAILED) {
              s2 = void 0;
            } else {
              peg$currPos = s2;
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f31();
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsemll_trailing() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c14) {
          s1 = peg$c14;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e19);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          peg$silentFails++;
          if (input.substr(peg$currPos, 3) === peg$c9) {
            s3 = peg$c9;
            peg$currPos += 3;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e11);
            }
          }
          peg$silentFails--;
          if (s3 !== peg$FAILED) {
            peg$currPos = s2;
            s2 = void 0;
          } else {
            s2 = peg$FAILED;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f32();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 39) {
            s1 = peg$c10;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e12);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            if (input.substr(peg$currPos, 3) === peg$c9) {
              s3 = peg$c9;
              peg$currPos += 3;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e11);
              }
            }
            peg$silentFails--;
            if (s3 !== peg$FAILED) {
              peg$currPos = s2;
              s2 = void 0;
            } else {
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f33();
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsestring_char() {
        let s0, s1, s2;
        s0 = peg$parseESCAPED();
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 92) {
            s1 = peg$c11;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e13);
            }
          }
          if (s1 !== peg$FAILED) {
            if (input.length > peg$currPos) {
              s2 = input.charAt(peg$currPos);
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e14);
              }
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f34();
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = [];
            s2 = input.charAt(peg$currPos);
            if (peg$r4.test(s2)) {
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e20);
              }
            }
            if (s2 !== peg$FAILED) {
              while (s2 !== peg$FAILED) {
                s1.push(s2);
                s2 = input.charAt(peg$currPos);
                if (peg$r4.test(s2)) {
                  peg$currPos++;
                } else {
                  s2 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e20);
                  }
                }
              }
            } else {
              s1 = peg$FAILED;
            }
            if (s1 !== peg$FAILED) {
              s0 = input.substring(s0, peg$currPos);
            } else {
              s0 = s1;
            }
          }
        }
        return s0;
      }
      function peg$parseliteral_char() {
        let s0, s1, s2;
        s0 = peg$currPos;
        s1 = [];
        s2 = input.charAt(peg$currPos);
        if (peg$r5.test(s2)) {
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e21);
          }
        }
        if (s2 !== peg$FAILED) {
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = input.charAt(peg$currPos);
            if (peg$r5.test(s2)) {
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e21);
              }
            }
          }
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        return s0;
      }
      function peg$parsefloat() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        s1 = peg$parsefloat_or_int_text();
        if (s1 !== peg$FAILED) {
          s2 = input.charAt(peg$currPos);
          if (peg$r6.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e22);
            }
          }
          if (s2 !== peg$FAILED) {
            s3 = peg$parsefloat_exp_text();
            if (s3 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f35(s1, s3);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parsefloat_text();
          if (s1 !== peg$FAILED) {
            peg$savedPos = s0;
            s1 = peg$f36(s1);
          }
          s0 = s1;
        }
        return s0;
      }
      function peg$parsefloat_text() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r1.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e6);
          }
        }
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        s2 = peg$parseFLOAT_DEC_INT();
        if (s2 !== peg$FAILED) {
          if (input.charCodeAt(peg$currPos) === 46) {
            s3 = peg$c3;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e4);
            }
          }
          if (s3 !== peg$FAILED) {
            s4 = peg$currPos;
            s5 = peg$parseDEC_DIGIT_SEQ();
            if (s5 !== peg$FAILED) {
              s4 = input.substring(s4, peg$currPos);
            } else {
              s4 = s5;
            }
            if (s4 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f37(s1, s2, s4);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsefloat_or_int_text() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r1.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e6);
          }
        }
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        s2 = peg$parseFLOAT_DEC_INT();
        if (s2 !== peg$FAILED) {
          if (input.charCodeAt(peg$currPos) === 46) {
            s3 = peg$c3;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e4);
            }
          }
          if (s3 !== peg$FAILED) {
            s4 = peg$currPos;
            s5 = peg$parseDEC_DIGIT_SEQ();
            if (s5 !== peg$FAILED) {
              s4 = input.substring(s4, peg$currPos);
            } else {
              s4 = s5;
            }
            if (s4 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f38(s1, s2, s4);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = input.charAt(peg$currPos);
          if (peg$r1.test(s1)) {
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e6);
            }
          }
          if (s1 === peg$FAILED) {
            s1 = null;
          }
          s2 = peg$parseFLOAT_DEC_INT();
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f39(s1, s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseFLOAT_DEC_INT() {
        let s0, s1;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 48) {
          s1 = peg$c15;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e23);
          }
        }
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f40();
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parseDEC_INT_NOZERO_SEQ();
          if (s1 !== peg$FAILED) {
            s0 = input.substring(s0, peg$currPos);
          } else {
            s0 = s1;
          }
        }
        return s0;
      }
      function peg$parsefloat_exp_text() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r1.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e6);
          }
        }
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        s2 = peg$currPos;
        s3 = peg$parseDEC_DIGIT_SEQ();
        if (s3 !== peg$FAILED) {
          s2 = input.substring(s2, peg$currPos);
        } else {
          s2 = s3;
        }
        if (s2 !== peg$FAILED) {
          peg$savedPos = s0;
          s0 = peg$f41(s1, s2);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseinteger() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c16) {
          s1 = peg$c16;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e24);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          s3 = peg$parseHEX_DIGIT_SEQ();
          if (s3 !== peg$FAILED) {
            s2 = input.substring(s2, peg$currPos);
          } else {
            s2 = s3;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f42(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 2) === peg$c17) {
            s1 = peg$c17;
            peg$currPos += 2;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e25);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            s3 = peg$parseOCT_DIGIT_SEQ();
            if (s3 !== peg$FAILED) {
              s2 = input.substring(s2, peg$currPos);
            } else {
              s2 = s3;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f43(s2);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.substr(peg$currPos, 2) === peg$c18) {
              s1 = peg$c18;
              peg$currPos += 2;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e26);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$currPos;
              s3 = peg$parseBIN_DIGIT_SEQ();
              if (s3 !== peg$FAILED) {
                s2 = input.substring(s2, peg$currPos);
              } else {
                s2 = s3;
              }
              if (s2 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f44(s2);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              s1 = peg$parsedec_integer_text();
              if (s1 !== peg$FAILED) {
                peg$savedPos = s0;
                s1 = peg$f45(s1);
              }
              s0 = s1;
            }
          }
        }
        return s0;
      }
      function peg$parsedec_integer_text() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r1.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e6);
          }
        }
        if (s1 === peg$FAILED) {
          s1 = null;
        }
        if (input.charCodeAt(peg$currPos) === 48) {
          s2 = peg$c15;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e23);
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = peg$currPos;
          peg$silentFails++;
          s4 = input.charAt(peg$currPos);
          if (peg$r7.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e27);
            }
          }
          peg$silentFails--;
          if (s4 === peg$FAILED) {
            s3 = void 0;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          if (s3 !== peg$FAILED) {
            s4 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 46) {
              s5 = peg$c3;
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e4);
              }
            }
            peg$silentFails--;
            if (s5 === peg$FAILED) {
              s4 = void 0;
            } else {
              peg$currPos = s4;
              s4 = peg$FAILED;
            }
            if (s4 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f46(s1);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = input.charAt(peg$currPos);
          if (peg$r1.test(s1)) {
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e6);
            }
          }
          if (s1 === peg$FAILED) {
            s1 = null;
          }
          s2 = peg$currPos;
          s3 = peg$parseDEC_INT_NOZERO_SEQ();
          if (s3 !== peg$FAILED) {
            s2 = input.substring(s2, peg$currPos);
          } else {
            s2 = s3;
          }
          if (s2 !== peg$FAILED) {
            s3 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 46) {
              s4 = peg$c3;
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e4);
              }
            }
            peg$silentFails--;
            if (s4 === peg$FAILED) {
              s3 = void 0;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
            if (s3 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f47(s1, s2);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseDEC_INT_NOZERO_SEQ() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r8.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e28);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$currPos;
          s4 = input.charAt(peg$currPos);
          if (peg$r9.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = input.charAt(peg$currPos);
          if (peg$r10.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e30);
            }
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$currPos;
            s4 = input.charAt(peg$currPos);
            if (peg$r9.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
            if (s4 === peg$FAILED) {
              s4 = null;
            }
            s5 = input.charAt(peg$currPos);
            if (peg$r10.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e30);
              }
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseDEC_DIGIT_SEQ() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r10.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e30);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$currPos;
          s4 = input.charAt(peg$currPos);
          if (peg$r9.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = input.charAt(peg$currPos);
          if (peg$r10.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e30);
            }
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$currPos;
            s4 = input.charAt(peg$currPos);
            if (peg$r9.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
            if (s4 === peg$FAILED) {
              s4 = null;
            }
            s5 = input.charAt(peg$currPos);
            if (peg$r10.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e30);
              }
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseHEX_DIGIT_SEQ() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r11.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e31);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$currPos;
          s4 = input.charAt(peg$currPos);
          if (peg$r9.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = input.charAt(peg$currPos);
          if (peg$r11.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e31);
            }
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$currPos;
            s4 = input.charAt(peg$currPos);
            if (peg$r9.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
            if (s4 === peg$FAILED) {
              s4 = null;
            }
            s5 = input.charAt(peg$currPos);
            if (peg$r11.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e31);
              }
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseOCT_DIGIT_SEQ() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r12.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e32);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$currPos;
          s4 = input.charAt(peg$currPos);
          if (peg$r9.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = input.charAt(peg$currPos);
          if (peg$r12.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e32);
            }
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$currPos;
            s4 = input.charAt(peg$currPos);
            if (peg$r9.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
            if (s4 === peg$FAILED) {
              s4 = null;
            }
            s5 = input.charAt(peg$currPos);
            if (peg$r12.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e32);
              }
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseBIN_DIGIT_SEQ() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (peg$r13.test(s1)) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e33);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$currPos;
          s4 = input.charAt(peg$currPos);
          if (peg$r9.test(s4)) {
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e29);
            }
          }
          if (s4 === peg$FAILED) {
            s4 = null;
          }
          s5 = input.charAt(peg$currPos);
          if (peg$r13.test(s5)) {
            peg$currPos++;
          } else {
            s5 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e33);
            }
          }
          if (s5 !== peg$FAILED) {
            s4 = [s4, s5];
            s3 = s4;
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$currPos;
            s4 = input.charAt(peg$currPos);
            if (peg$r9.test(s4)) {
              peg$currPos++;
            } else {
              s4 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e29);
              }
            }
            if (s4 === peg$FAILED) {
              s4 = null;
            }
            s5 = input.charAt(peg$currPos);
            if (peg$r13.test(s5)) {
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e33);
              }
            }
            if (s5 !== peg$FAILED) {
              s4 = [s4, s5];
              s3 = s4;
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          }
          s1 = [s1, s2];
          s0 = s1;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseboolean() {
        let s0, s1;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 4) === peg$c19) {
          s1 = peg$c19;
          peg$currPos += 4;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e34);
          }
        }
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f48();
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 5) === peg$c20) {
            s1 = peg$c20;
            peg$currPos += 5;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e35);
            }
          }
          if (s1 !== peg$FAILED) {
            peg$savedPos = s0;
            s1 = peg$f49();
          }
          s0 = s1;
        }
        return s0;
      }
      function peg$parsearray() {
        let s0, s1, s2, s3, s4, s5, s6, s7, s8, s9;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 91) {
          s1 = peg$c1;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e2);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parsearray_sep();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parsearray_sep();
          }
          if (input.charCodeAt(peg$currPos) === 93) {
            s3 = peg$c2;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e3);
            }
          }
          if (s3 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f50();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 91) {
            s1 = peg$c1;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e2);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parsearray_sep();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parsearray_sep();
            }
            s3 = peg$parsevalue();
            if (s3 !== peg$FAILED) {
              s4 = [];
              s5 = peg$currPos;
              s6 = [];
              s7 = peg$parsearray_sep();
              while (s7 !== peg$FAILED) {
                s6.push(s7);
                s7 = peg$parsearray_sep();
              }
              if (input.charCodeAt(peg$currPos) === 44) {
                s7 = peg$c21;
                peg$currPos++;
              } else {
                s7 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e36);
                }
              }
              if (s7 !== peg$FAILED) {
                s8 = [];
                s9 = peg$parsearray_sep();
                while (s9 !== peg$FAILED) {
                  s8.push(s9);
                  s9 = peg$parsearray_sep();
                }
                s9 = peg$parsevalue();
                if (s9 !== peg$FAILED) {
                  peg$savedPos = s5;
                  s5 = peg$f51(s3, s9);
                } else {
                  peg$currPos = s5;
                  s5 = peg$FAILED;
                }
              } else {
                peg$currPos = s5;
                s5 = peg$FAILED;
              }
              while (s5 !== peg$FAILED) {
                s4.push(s5);
                s5 = peg$currPos;
                s6 = [];
                s7 = peg$parsearray_sep();
                while (s7 !== peg$FAILED) {
                  s6.push(s7);
                  s7 = peg$parsearray_sep();
                }
                if (input.charCodeAt(peg$currPos) === 44) {
                  s7 = peg$c21;
                  peg$currPos++;
                } else {
                  s7 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e36);
                  }
                }
                if (s7 !== peg$FAILED) {
                  s8 = [];
                  s9 = peg$parsearray_sep();
                  while (s9 !== peg$FAILED) {
                    s8.push(s9);
                    s9 = peg$parsearray_sep();
                  }
                  s9 = peg$parsevalue();
                  if (s9 !== peg$FAILED) {
                    peg$savedPos = s5;
                    s5 = peg$f51(s3, s9);
                  } else {
                    peg$currPos = s5;
                    s5 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s5;
                  s5 = peg$FAILED;
                }
              }
              s5 = [];
              s6 = peg$parsearray_sep();
              while (s6 !== peg$FAILED) {
                s5.push(s6);
                s6 = peg$parsearray_sep();
              }
              if (input.charCodeAt(peg$currPos) === 44) {
                s6 = peg$c21;
                peg$currPos++;
              } else {
                s6 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e36);
                }
              }
              if (s6 === peg$FAILED) {
                s6 = null;
              }
              s7 = [];
              s8 = peg$parsearray_sep();
              while (s8 !== peg$FAILED) {
                s7.push(s8);
                s8 = peg$parsearray_sep();
              }
              if (input.charCodeAt(peg$currPos) === 93) {
                s8 = peg$c2;
                peg$currPos++;
              } else {
                s8 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e3);
                }
              }
              if (s8 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f52(s3, s4);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parsearray_sep() {
        let s0;
        s0 = peg$parseS();
        if (s0 === peg$FAILED) {
          s0 = peg$parseNL();
          if (s0 === peg$FAILED) {
            s0 = peg$parsecomment();
          }
        }
        return s0;
      }
      function peg$parseinline_table() {
        let s0, s1, s2, s3, s4, s5, s6, s7, s8, s9;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 123) {
          s1 = peg$c22;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e37);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseinline_sep();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseinline_sep();
          }
          if (input.charCodeAt(peg$currPos) === 125) {
            s3 = peg$c23;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e38);
            }
          }
          if (s3 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f53();
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 123) {
            s1 = peg$c22;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e37);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = [];
            s3 = peg$parseinline_sep();
            while (s3 !== peg$FAILED) {
              s2.push(s3);
              s3 = peg$parseinline_sep();
            }
            s3 = peg$parseinline_table_entry();
            if (s3 !== peg$FAILED) {
              s4 = [];
              s5 = peg$currPos;
              s6 = [];
              s7 = peg$parseinline_sep();
              while (s7 !== peg$FAILED) {
                s6.push(s7);
                s7 = peg$parseinline_sep();
              }
              if (input.charCodeAt(peg$currPos) === 44) {
                s7 = peg$c21;
                peg$currPos++;
              } else {
                s7 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e36);
                }
              }
              if (s7 !== peg$FAILED) {
                s8 = [];
                s9 = peg$parseinline_sep();
                while (s9 !== peg$FAILED) {
                  s8.push(s9);
                  s9 = peg$parseinline_sep();
                }
                s9 = peg$parseinline_table_entry();
                if (s9 !== peg$FAILED) {
                  peg$savedPos = s5;
                  s5 = peg$f54(s3, s9);
                } else {
                  peg$currPos = s5;
                  s5 = peg$FAILED;
                }
              } else {
                peg$currPos = s5;
                s5 = peg$FAILED;
              }
              while (s5 !== peg$FAILED) {
                s4.push(s5);
                s5 = peg$currPos;
                s6 = [];
                s7 = peg$parseinline_sep();
                while (s7 !== peg$FAILED) {
                  s6.push(s7);
                  s7 = peg$parseinline_sep();
                }
                if (input.charCodeAt(peg$currPos) === 44) {
                  s7 = peg$c21;
                  peg$currPos++;
                } else {
                  s7 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e36);
                  }
                }
                if (s7 !== peg$FAILED) {
                  s8 = [];
                  s9 = peg$parseinline_sep();
                  while (s9 !== peg$FAILED) {
                    s8.push(s9);
                    s9 = peg$parseinline_sep();
                  }
                  s9 = peg$parseinline_table_entry();
                  if (s9 !== peg$FAILED) {
                    peg$savedPos = s5;
                    s5 = peg$f54(s3, s9);
                  } else {
                    peg$currPos = s5;
                    s5 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s5;
                  s5 = peg$FAILED;
                }
              }
              s5 = [];
              s6 = peg$parseinline_sep();
              while (s6 !== peg$FAILED) {
                s5.push(s6);
                s6 = peg$parseinline_sep();
              }
              if (input.charCodeAt(peg$currPos) === 44) {
                s6 = peg$c21;
                peg$currPos++;
              } else {
                s6 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e36);
                }
              }
              if (s6 === peg$FAILED) {
                s6 = null;
              }
              s7 = [];
              s8 = peg$parseinline_sep();
              while (s8 !== peg$FAILED) {
                s7.push(s8);
                s8 = peg$parseinline_sep();
              }
              if (input.charCodeAt(peg$currPos) === 125) {
                s8 = peg$c23;
                peg$currPos++;
              } else {
                s8 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e38);
                }
              }
              if (s8 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f55(s3, s4);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseinline_table_entry() {
        let s0, s1, s2, s3, s4, s5;
        s0 = peg$currPos;
        s1 = peg$parseinline_key();
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseS();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseS();
          }
          if (input.charCodeAt(peg$currPos) === 61) {
            s3 = peg$c4;
            peg$currPos++;
          } else {
            s3 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e5);
            }
          }
          if (s3 !== peg$FAILED) {
            s4 = [];
            s5 = peg$parseS();
            while (s5 !== peg$FAILED) {
              s4.push(s5);
              s5 = peg$parseS();
            }
            s5 = peg$parsevalue();
            if (s5 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f56(s1, s5);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseinline_sep() {
        let s0;
        s0 = peg$parseS();
        if (s0 === peg$FAILED) {
          s0 = peg$parseNL();
          if (s0 === peg$FAILED) {
            s0 = peg$parsecomment();
          }
        }
        return s0;
      }
      function peg$parseinline_key() {
        let s0, s1, s2, s3;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseinline_dot_key_part();
        if (s2 !== peg$FAILED) {
          while (s2 !== peg$FAILED) {
            s1.push(s2);
            s2 = peg$parseinline_dot_key_part();
          }
        } else {
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s2 = [];
          s3 = peg$parseS();
          while (s3 !== peg$FAILED) {
            s2.push(s3);
            s3 = peg$parseS();
          }
          s3 = peg$parsesimple_key();
          if (s3 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f57(s1, s3);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parsesimple_key();
          if (s1 !== peg$FAILED) {
            peg$savedPos = s0;
            s1 = peg$f58(s1);
          }
          s0 = s1;
        }
        return s0;
      }
      function peg$parseinline_dot_key_part() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        s1 = [];
        s2 = peg$parseS();
        while (s2 !== peg$FAILED) {
          s1.push(s2);
          s2 = peg$parseS();
        }
        s2 = peg$parsesimple_key();
        if (s2 !== peg$FAILED) {
          s3 = [];
          s4 = peg$parseS();
          while (s4 !== peg$FAILED) {
            s3.push(s4);
            s4 = peg$parseS();
          }
          if (input.charCodeAt(peg$currPos) === 46) {
            s4 = peg$c3;
            peg$currPos++;
          } else {
            s4 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e4);
            }
          }
          if (s4 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f59(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parsesimple_key() {
        let s0;
        s0 = peg$parsekey();
        if (s0 === peg$FAILED) {
          s0 = peg$parsequoted_key();
        }
        return s0;
      }
      function peg$parsesecfragment() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        s1 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 46) {
          s2 = peg$c3;
          peg$currPos++;
        } else {
          s2 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e4);
          }
        }
        if (s2 !== peg$FAILED) {
          s3 = [];
          s4 = peg$parseDIGIT();
          if (s4 !== peg$FAILED) {
            while (s4 !== peg$FAILED) {
              s3.push(s4);
              s4 = peg$parseDIGIT();
            }
          } else {
            s3 = peg$FAILED;
          }
          if (s3 !== peg$FAILED) {
            s2 = [s2, s3];
            s1 = s2;
          } else {
            peg$currPos = s1;
            s1 = peg$FAILED;
          }
        } else {
          peg$currPos = s1;
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        return s0;
      }
      function peg$parsedate_part() {
        let s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11;
        s0 = peg$currPos;
        s1 = peg$currPos;
        s2 = peg$parseDIGIT();
        if (s2 !== peg$FAILED) {
          s3 = peg$parseDIGIT();
          if (s3 !== peg$FAILED) {
            s4 = peg$parseDIGIT();
            if (s4 !== peg$FAILED) {
              s5 = peg$parseDIGIT();
              if (s5 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 45) {
                  s6 = peg$c24;
                  peg$currPos++;
                } else {
                  s6 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e39);
                  }
                }
                if (s6 !== peg$FAILED) {
                  s7 = peg$parseDIGIT();
                  if (s7 !== peg$FAILED) {
                    s8 = peg$parseDIGIT();
                    if (s8 !== peg$FAILED) {
                      if (input.charCodeAt(peg$currPos) === 45) {
                        s9 = peg$c24;
                        peg$currPos++;
                      } else {
                        s9 = peg$FAILED;
                        if (peg$silentFails === 0) {
                          peg$fail(peg$e39);
                        }
                      }
                      if (s9 !== peg$FAILED) {
                        s10 = peg$parseDIGIT();
                        if (s10 !== peg$FAILED) {
                          s11 = peg$parseDIGIT();
                          if (s11 !== peg$FAILED) {
                            s2 = [s2, s3, s4, s5, s6, s7, s8, s9, s10, s11];
                            s1 = s2;
                          } else {
                            peg$currPos = s1;
                            s1 = peg$FAILED;
                          }
                        } else {
                          peg$currPos = s1;
                          s1 = peg$FAILED;
                        }
                      } else {
                        peg$currPos = s1;
                        s1 = peg$FAILED;
                      }
                    } else {
                      peg$currPos = s1;
                      s1 = peg$FAILED;
                    }
                  } else {
                    peg$currPos = s1;
                    s1 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s1;
                  s1 = peg$FAILED;
                }
              } else {
                peg$currPos = s1;
                s1 = peg$FAILED;
              }
            } else {
              peg$currPos = s1;
              s1 = peg$FAILED;
            }
          } else {
            peg$currPos = s1;
            s1 = peg$FAILED;
          }
        } else {
          peg$currPos = s1;
          s1 = peg$FAILED;
        }
        if (s1 !== peg$FAILED) {
          s0 = input.substring(s0, peg$currPos);
        } else {
          s0 = s1;
        }
        return s0;
      }
      function peg$parsetime_part() {
        let s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10;
        s0 = peg$currPos;
        s1 = peg$currPos;
        s2 = peg$currPos;
        s3 = peg$parseDIGIT();
        if (s3 !== peg$FAILED) {
          s4 = peg$parseDIGIT();
          if (s4 !== peg$FAILED) {
            if (input.charCodeAt(peg$currPos) === 58) {
              s5 = peg$c25;
              peg$currPos++;
            } else {
              s5 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e40);
              }
            }
            if (s5 !== peg$FAILED) {
              s6 = peg$parseDIGIT();
              if (s6 !== peg$FAILED) {
                s7 = peg$parseDIGIT();
                if (s7 !== peg$FAILED) {
                  if (input.charCodeAt(peg$currPos) === 58) {
                    s8 = peg$c25;
                    peg$currPos++;
                  } else {
                    s8 = peg$FAILED;
                    if (peg$silentFails === 0) {
                      peg$fail(peg$e40);
                    }
                  }
                  if (s8 !== peg$FAILED) {
                    s9 = peg$parseDIGIT();
                    if (s9 !== peg$FAILED) {
                      s10 = peg$parseDIGIT();
                      if (s10 !== peg$FAILED) {
                        s3 = [s3, s4, s5, s6, s7, s8, s9, s10];
                        s2 = s3;
                      } else {
                        peg$currPos = s2;
                        s2 = peg$FAILED;
                      }
                    } else {
                      peg$currPos = s2;
                      s2 = peg$FAILED;
                    }
                  } else {
                    peg$currPos = s2;
                    s2 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$FAILED;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$FAILED;
              }
            } else {
              peg$currPos = s2;
              s2 = peg$FAILED;
            }
          } else {
            peg$currPos = s2;
            s2 = peg$FAILED;
          }
        } else {
          peg$currPos = s2;
          s2 = peg$FAILED;
        }
        if (s2 !== peg$FAILED) {
          s1 = input.substring(s1, peg$currPos);
        } else {
          s1 = s2;
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$parsesecfragment();
          if (s2 === peg$FAILED) {
            s2 = null;
          }
          peg$savedPos = s0;
          s0 = peg$f60(s1, s2);
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$currPos;
          s2 = peg$currPos;
          s3 = peg$parseDIGIT();
          if (s3 !== peg$FAILED) {
            s4 = peg$parseDIGIT();
            if (s4 !== peg$FAILED) {
              if (input.charCodeAt(peg$currPos) === 58) {
                s5 = peg$c25;
                peg$currPos++;
              } else {
                s5 = peg$FAILED;
                if (peg$silentFails === 0) {
                  peg$fail(peg$e40);
                }
              }
              if (s5 !== peg$FAILED) {
                s6 = peg$parseDIGIT();
                if (s6 !== peg$FAILED) {
                  s7 = peg$parseDIGIT();
                  if (s7 !== peg$FAILED) {
                    s3 = [s3, s4, s5, s6, s7];
                    s2 = s3;
                  } else {
                    peg$currPos = s2;
                    s2 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s2;
                  s2 = peg$FAILED;
                }
              } else {
                peg$currPos = s2;
                s2 = peg$FAILED;
              }
            } else {
              peg$currPos = s2;
              s2 = peg$FAILED;
            }
          } else {
            peg$currPos = s2;
            s2 = peg$FAILED;
          }
          if (s2 !== peg$FAILED) {
            s1 = input.substring(s1, peg$currPos);
          } else {
            s1 = s2;
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            if (input.charCodeAt(peg$currPos) === 58) {
              s3 = peg$c25;
              peg$currPos++;
            } else {
              s3 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e40);
              }
            }
            peg$silentFails--;
            if (s3 === peg$FAILED) {
              s2 = void 0;
            } else {
              peg$currPos = s2;
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f61(s1);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseoffset() {
        let s0, s1, s2, s3, s4, s5, s6, s7;
        s0 = peg$currPos;
        s1 = input.charAt(peg$currPos);
        if (s1.toLowerCase() === peg$c26) {
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e41);
          }
        }
        if (s1 !== peg$FAILED) {
          peg$savedPos = s0;
          s1 = peg$f62();
        }
        s0 = s1;
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$currPos;
          s2 = input.charAt(peg$currPos);
          if (peg$r1.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e6);
            }
          }
          if (s2 !== peg$FAILED) {
            s3 = peg$parseDIGIT();
            if (s3 !== peg$FAILED) {
              s4 = peg$parseDIGIT();
              if (s4 !== peg$FAILED) {
                if (input.charCodeAt(peg$currPos) === 58) {
                  s5 = peg$c25;
                  peg$currPos++;
                } else {
                  s5 = peg$FAILED;
                  if (peg$silentFails === 0) {
                    peg$fail(peg$e40);
                  }
                }
                if (s5 !== peg$FAILED) {
                  s6 = peg$parseDIGIT();
                  if (s6 !== peg$FAILED) {
                    s7 = peg$parseDIGIT();
                    if (s7 !== peg$FAILED) {
                      s2 = [s2, s3, s4, s5, s6, s7];
                      s1 = s2;
                    } else {
                      peg$currPos = s1;
                      s1 = peg$FAILED;
                    }
                  } else {
                    peg$currPos = s1;
                    s1 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s1;
                  s1 = peg$FAILED;
                }
              } else {
                peg$currPos = s1;
                s1 = peg$FAILED;
              }
            } else {
              peg$currPos = s1;
              s1 = peg$FAILED;
            }
          } else {
            peg$currPos = s1;
            s1 = peg$FAILED;
          }
          if (s1 !== peg$FAILED) {
            s0 = input.substring(s0, peg$currPos);
          } else {
            s0 = s1;
          }
        }
        return s0;
      }
      function peg$parsedatetime() {
        let s0, s1, s2, s3, s4;
        s0 = peg$currPos;
        s1 = peg$parsedate_part();
        if (s1 !== peg$FAILED) {
          s2 = peg$parsedatetime_delim();
          if (s2 !== peg$FAILED) {
            s3 = peg$parsetime_part();
            if (s3 !== peg$FAILED) {
              s4 = peg$parseoffset();
              if (s4 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f63(s1, s3, s4);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          s1 = peg$parsedate_part();
          if (s1 !== peg$FAILED) {
            s2 = peg$parsedatetime_delim();
            if (s2 !== peg$FAILED) {
              s3 = peg$parsetime_part();
              if (s3 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f64(s1, s3);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            s1 = peg$parsedate_part();
            if (s1 !== peg$FAILED) {
              s2 = peg$currPos;
              peg$silentFails++;
              s3 = peg$parsedatetime_delim();
              peg$silentFails--;
              if (s3 === peg$FAILED) {
                s2 = void 0;
              } else {
                peg$currPos = s2;
                s2 = peg$FAILED;
              }
              if (s2 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f65(s1);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
            if (s0 === peg$FAILED) {
              s0 = peg$currPos;
              s1 = peg$parsetime_part();
              if (s1 !== peg$FAILED) {
                peg$savedPos = s0;
                s1 = peg$f66(s1);
              }
              s0 = s1;
            }
          }
        }
        return s0;
      }
      function peg$parsedatetime_delim() {
        let s0, s1, s2, s3;
        s0 = input.charAt(peg$currPos);
        if (s0.toLowerCase() === peg$c27) {
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e42);
          }
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 32) {
            s1 = peg$c28;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e43);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            peg$silentFails++;
            s3 = peg$parseDIGIT();
            peg$silentFails--;
            if (s3 !== peg$FAILED) {
              peg$currPos = s2;
              s2 = void 0;
            } else {
              s2 = peg$FAILED;
            }
            if (s2 !== peg$FAILED) {
              s1 = [s1, s2];
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseS() {
        let s0;
        s0 = input.charAt(peg$currPos);
        if (peg$r14.test(s0)) {
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e44);
          }
        }
        return s0;
      }
      function peg$parseNL() {
        let s0, s1, s2;
        if (input.charCodeAt(peg$currPos) === 10) {
          s0 = peg$c29;
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e45);
          }
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.charCodeAt(peg$currPos) === 13) {
            s1 = peg$c30;
            peg$currPos++;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e46);
            }
          }
          if (s1 !== peg$FAILED) {
            if (input.charCodeAt(peg$currPos) === 10) {
              s2 = peg$c29;
              peg$currPos++;
            } else {
              s2 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e45);
              }
            }
            if (s2 !== peg$FAILED) {
              s1 = [s1, s2];
              s0 = s1;
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        }
        return s0;
      }
      function peg$parseNLS() {
        let s0;
        s0 = peg$parseNL();
        if (s0 === peg$FAILED) {
          s0 = peg$parseS();
        }
        return s0;
      }
      function peg$parseEOF() {
        let s0, s1;
        s0 = peg$currPos;
        peg$silentFails++;
        if (input.length > peg$currPos) {
          s1 = input.charAt(peg$currPos);
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e14);
          }
        }
        peg$silentFails--;
        if (s1 === peg$FAILED) {
          s0 = void 0;
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        return s0;
      }
      function peg$parseBOM() {
        let s0;
        if (input.charCodeAt(peg$currPos) === 65279) {
          s0 = peg$c31;
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e47);
          }
        }
        return s0;
      }
      function peg$parseDIGIT() {
        let s0;
        s0 = input.charAt(peg$currPos);
        if (peg$r10.test(s0)) {
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e30);
          }
        }
        return s0;
      }
      function peg$parseHEX() {
        let s0;
        s0 = input.charAt(peg$currPos);
        if (peg$r11.test(s0)) {
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e31);
          }
        }
        return s0;
      }
      function peg$parseASCII_BASIC() {
        let s0;
        s0 = input.charAt(peg$currPos);
        if (peg$r15.test(s0)) {
          peg$currPos++;
        } else {
          s0 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e48);
          }
        }
        return s0;
      }
      function peg$parseESCAPED() {
        let s0, s1, s2;
        s0 = peg$currPos;
        if (input.charCodeAt(peg$currPos) === 92) {
          s1 = peg$c11;
          peg$currPos++;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e13);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = input.charAt(peg$currPos);
          if (peg$r16.test(s2)) {
            peg$currPos++;
          } else {
            s2 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e49);
            }
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f67(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$parseESCAPED_UNICODE();
        }
        return s0;
      }
      function peg$parseESCAPED_UNICODE() {
        let s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11;
        s0 = peg$currPos;
        if (input.substr(peg$currPos, 2) === peg$c32) {
          s1 = peg$c32;
          peg$currPos += 2;
        } else {
          s1 = peg$FAILED;
          if (peg$silentFails === 0) {
            peg$fail(peg$e50);
          }
        }
        if (s1 !== peg$FAILED) {
          s2 = peg$currPos;
          s3 = peg$currPos;
          s4 = peg$parseHEX();
          if (s4 !== peg$FAILED) {
            s5 = peg$parseHEX();
            if (s5 !== peg$FAILED) {
              s6 = peg$parseHEX();
              if (s6 !== peg$FAILED) {
                s7 = peg$parseHEX();
                if (s7 !== peg$FAILED) {
                  s8 = peg$parseHEX();
                  if (s8 !== peg$FAILED) {
                    s9 = peg$parseHEX();
                    if (s9 !== peg$FAILED) {
                      s10 = peg$parseHEX();
                      if (s10 !== peg$FAILED) {
                        s11 = peg$parseHEX();
                        if (s11 !== peg$FAILED) {
                          s4 = [s4, s5, s6, s7, s8, s9, s10, s11];
                          s3 = s4;
                        } else {
                          peg$currPos = s3;
                          s3 = peg$FAILED;
                        }
                      } else {
                        peg$currPos = s3;
                        s3 = peg$FAILED;
                      }
                    } else {
                      peg$currPos = s3;
                      s3 = peg$FAILED;
                    }
                  } else {
                    peg$currPos = s3;
                    s3 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s3;
                  s3 = peg$FAILED;
                }
              } else {
                peg$currPos = s3;
                s3 = peg$FAILED;
              }
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
          } else {
            peg$currPos = s3;
            s3 = peg$FAILED;
          }
          if (s3 !== peg$FAILED) {
            s2 = input.substring(s2, peg$currPos);
          } else {
            s2 = s3;
          }
          if (s2 !== peg$FAILED) {
            peg$savedPos = s0;
            s0 = peg$f68(s2);
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
        } else {
          peg$currPos = s0;
          s0 = peg$FAILED;
        }
        if (s0 === peg$FAILED) {
          s0 = peg$currPos;
          if (input.substr(peg$currPos, 2) === peg$c33) {
            s1 = peg$c33;
            peg$currPos += 2;
          } else {
            s1 = peg$FAILED;
            if (peg$silentFails === 0) {
              peg$fail(peg$e51);
            }
          }
          if (s1 !== peg$FAILED) {
            s2 = peg$currPos;
            s3 = peg$currPos;
            s4 = peg$parseHEX();
            if (s4 !== peg$FAILED) {
              s5 = peg$parseHEX();
              if (s5 !== peg$FAILED) {
                s6 = peg$parseHEX();
                if (s6 !== peg$FAILED) {
                  s7 = peg$parseHEX();
                  if (s7 !== peg$FAILED) {
                    s4 = [s4, s5, s6, s7];
                    s3 = s4;
                  } else {
                    peg$currPos = s3;
                    s3 = peg$FAILED;
                  }
                } else {
                  peg$currPos = s3;
                  s3 = peg$FAILED;
                }
              } else {
                peg$currPos = s3;
                s3 = peg$FAILED;
              }
            } else {
              peg$currPos = s3;
              s3 = peg$FAILED;
            }
            if (s3 !== peg$FAILED) {
              s2 = input.substring(s2, peg$currPos);
            } else {
              s2 = s3;
            }
            if (s2 !== peg$FAILED) {
              peg$savedPos = s0;
              s0 = peg$f69(s2);
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          } else {
            peg$currPos = s0;
            s0 = peg$FAILED;
          }
          if (s0 === peg$FAILED) {
            s0 = peg$currPos;
            if (input.substr(peg$currPos, 2) === peg$c34) {
              s1 = peg$c34;
              peg$currPos += 2;
            } else {
              s1 = peg$FAILED;
              if (peg$silentFails === 0) {
                peg$fail(peg$e52);
              }
            }
            if (s1 !== peg$FAILED) {
              s2 = peg$currPos;
              s3 = peg$currPos;
              s4 = peg$parseHEX();
              if (s4 !== peg$FAILED) {
                s5 = peg$parseHEX();
                if (s5 !== peg$FAILED) {
                  s4 = [s4, s5];
                  s3 = s4;
                } else {
                  peg$currPos = s3;
                  s3 = peg$FAILED;
                }
              } else {
                peg$currPos = s3;
                s3 = peg$FAILED;
              }
              if (s3 !== peg$FAILED) {
                s2 = input.substring(s2, peg$currPos);
              } else {
                s2 = s3;
              }
              if (s2 !== peg$FAILED) {
                peg$savedPos = s0;
                s0 = peg$f70(s2);
              } else {
                peg$currPos = s0;
                s0 = peg$FAILED;
              }
            } else {
              peg$currPos = s0;
              s0 = peg$FAILED;
            }
          }
        }
        return s0;
      }
      var nodes = [];
      var inputText = input;
      var depth = 0;
      var MAX_DEPTH = options && options.maxDepth != null ? options.maxDepth : 500;
      function resolveLineCol(off) {
        var line = 1, col = 1;
        for (var i = 0; i < off; i++) {
          if (inputText.charCodeAt(i) === 10) {
            line++;
            col = 1;
          } else {
            col++;
          }
        }
        return { line, column: col };
      }
      function genError(err, off) {
        var pos = resolveLineCol(off);
        var ex = new Error(err);
        ex.line = pos.line;
        ex.column = pos.column;
        throw ex;
      }
      function addNode(node2) {
        nodes.push(node2);
      }
      function node(type, value, off, key2) {
        var obj = { type, value, offset: off };
        if (key2) obj.key = key2;
        return obj;
      }
      function validateDate(dateStr, off) {
        var year = dateStr.charCodeAt(0) * 1e3 + dateStr.charCodeAt(1) * 100 + dateStr.charCodeAt(2) * 10 + dateStr.charCodeAt(3) - 53328;
        var month = (dateStr.charCodeAt(5) - 48) * 10 + dateStr.charCodeAt(6) - 48;
        var day = (dateStr.charCodeAt(8) - 48) * 10 + dateStr.charCodeAt(9) - 48;
        if (month < 1 || month > 12) {
          genError("Invalid date: month " + month + " out of range.", off);
        }
        var maxDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (year % 4 === 0 && year % 100 !== 0 || year % 400 === 0) {
          maxDays[1] = 29;
        }
        if (day < 1 || day > maxDays[month - 1]) {
          genError("Invalid date: day " + day + " out of range for month " + month + ".", off);
        }
      }
      function validateTime(timeStr, off) {
        var hour = (timeStr.charCodeAt(0) - 48) * 10 + timeStr.charCodeAt(1) - 48;
        var minute = (timeStr.charCodeAt(3) - 48) * 10 + timeStr.charCodeAt(4) - 48;
        var second = (timeStr.charCodeAt(6) - 48) * 10 + timeStr.charCodeAt(7) - 48;
        if (hour > 23) {
          genError("Invalid time: hour " + hour + " out of range.", off);
        }
        if (minute > 59) {
          genError("Invalid time: minute " + minute + " out of range.", off);
        }
        if (second > 59) {
          genError("Invalid time: second " + second + " out of range.", off);
        }
      }
      function validateOffset(offsetStr, off) {
        if (offsetStr === "Z" || offsetStr === "z") return;
        var hour = (offsetStr.charCodeAt(1) - 48) * 10 + offsetStr.charCodeAt(2) - 48;
        var minute = (offsetStr.charCodeAt(4) - 48) * 10 + offsetStr.charCodeAt(5) - 48;
        if (hour > 23) {
          genError("Invalid offset: hour " + hour + " out of range.", off);
        }
        if (minute > 59) {
          genError("Invalid offset: minute " + minute + " out of range.", off);
        }
      }
      function stripUnderscores(str) {
        return str.indexOf("_") === -1 ? str : str.replace(/_/g, "");
      }
      function convertCodePoint(str) {
        var num2 = parseInt(str, 16);
        if (num2 !== num2 || num2 < 0 || num2 > 1114111 || num2 > 55295 && num2 < 57344) {
          genError("Invalid Unicode escape code: " + str, offset());
        } else {
          return String.fromCodePoint(num2);
        }
      }
      peg$result = peg$startRuleFunction();
      const peg$success = peg$result !== peg$FAILED && peg$currPos === input.length;
      function peg$throw() {
        if (peg$result !== peg$FAILED && peg$currPos < input.length) {
          peg$fail(peg$endExpectation());
        }
        throw peg$buildStructuredError(
          peg$maxFailExpected,
          peg$maxFailPos < input.length ? peg$getUnicode(peg$maxFailPos) : null,
          peg$maxFailPos < input.length ? peg$computeLocation(peg$maxFailPos, peg$maxFailPos + 1) : peg$computeLocation(peg$maxFailPos, peg$maxFailPos)
        );
      }
      if (options.peg$library) {
        return (
          /** @type {any} */
          {
            peg$result,
            peg$currPos,
            peg$FAILED,
            peg$maxFailExpected,
            peg$maxFailPos,
            peg$success,
            peg$throw: peg$success ? void 0 : peg$throw
          }
        );
      }
      if (peg$success) {
        return peg$result;
      } else {
        peg$throw();
      }
    }
    module.exports = {
      StartRules: ["start"],
      SyntaxError: peg$SyntaxError,
      parse: peg$parse
    };
  }
});

// sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/lib/compiler.js
var require_compiler = __commonJS({
  "sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/lib/compiler.js"(exports, module) {
    "use strict";
    function compile(nodes, inputText) {
      var assignedPaths = /* @__PURE__ */ new Set();
      var valueAssignments = /* @__PURE__ */ new Set();
      var explicitTablePaths = /* @__PURE__ */ new Set();
      var currentPath = [];
      var ownedContainers = /* @__PURE__ */ new WeakSet();
      var data = createTable();
      var context = data;
      return reduce(nodes);
      function reduce(nodes2) {
        var node;
        for (var i = 0; i < nodes2.length; i++) {
          node = nodes2[i];
          switch (node.type) {
            case "Assign":
              assign(node);
              break;
            case "ObjectPath":
              setPath(node);
              break;
            case "ArrayPath":
              addTableArray(node);
              break;
          }
        }
        return data;
      }
      function resolveLineCol(off) {
        var line = 1, col = 1;
        for (var i = 0; i < off; i++) {
          if (inputText.charCodeAt(i) === 10) {
            line++;
            col = 1;
          } else {
            col++;
          }
        }
        return { line, column: col };
      }
      function genError(err, off) {
        var pos = resolveLineCol(off);
        var ex = new Error(err);
        ex.line = pos.line;
        ex.column = pos.column;
        throw ex;
      }
      function assign(node) {
        var keys = node.key;
        var value = node.value;
        var off = node.offset;
        if (!Array.isArray(keys)) keys = [keys];
        var reduced = reduceValueNode(value);
        var target = context;
        for (var i = 0; i < keys.length - 1; i++) {
          var k = keys[i];
          var intermediatePath = makeFullPath(keys.slice(0, i + 1));
          if (typeof target[k] === "undefined") {
            target[k] = createTable();
            assignedPaths.add(intermediatePath);
          } else if (typeof target[k] !== "object" || target[k] === null || Array.isArray(target[k])) {
            genError("Cannot redefine existing key '" + intermediatePath + "'.", off);
          } else if (valueAssignments.has(intermediatePath)) {
            genError("Cannot redefine existing key '" + intermediatePath + "'.", off);
          } else if (explicitTablePaths.has(intermediatePath) && intermediatePath !== pathKey(currentPath)) {
            genError("Cannot use dotted keys to extend table '" + intermediatePath + "' defined elsewhere.", off);
          }
          target = target[k];
        }
        var lastKey = keys[keys.length - 1];
        var fullPath = makeFullPath(keys);
        if (typeof target[lastKey] !== "undefined") {
          genError("Cannot redefine existing key '" + fullPath + "'.", off);
        }
        target[lastKey] = reduced;
        assignedPaths.add(fullPath);
        valueAssignments.add(fullPath);
      }
      function reduceValueNode(node) {
        if (node.type === "Array") {
          return reduceArray(node.value);
        } else if (node.type === "InlineTable") {
          return reduceInlineTableNode(node.value);
        } else {
          return node.value;
        }
      }
      function reduceInlineTableNode(values) {
        var obj = createTable();
        var definedKeys = /* @__PURE__ */ new Set();
        for (var i = 0; i < values.length; i++) {
          var val = values[i];
          if (val.type !== "InlineTableValue") continue;
          var keys = val.key;
          if (!Array.isArray(keys)) keys = [keys];
          var reduced = reduceValueNode(val.value);
          setNestedKey(obj, keys, reduced, val.offset, definedKeys);
          definedKeys.add(pathKey(keys));
        }
        return obj;
      }
      function setNestedKey(obj, keys, value, off, definedKeys) {
        for (var i = 0; i < keys.length - 1; i++) {
          var k = keys[i];
          var intermediatePath = pathKey(keys.slice(0, i + 1));
          if (typeof obj[k] === "undefined") {
            obj[k] = createTable();
          } else if (typeof obj[k] !== "object" || obj[k] === null || Array.isArray(obj[k])) {
            genError("Cannot redefine existing key '" + intermediatePath + "'.", off);
          } else if (definedKeys && definedKeys.has(intermediatePath)) {
            genError("Cannot extend inline table '" + intermediatePath + "'.", off);
          }
          obj = obj[k];
        }
        var lastKey = keys[keys.length - 1];
        if (typeof obj[lastKey] !== "undefined") {
          genError("Cannot redefine existing key '" + pathKey(keys) + "'.", off);
        }
        obj[lastKey] = value;
      }
      function setPath(node) {
        var path = node.value;
        var quotedPath = path.map(quoteDottedString).join(".");
        var off = node.offset;
        if (assignedPaths.has(quotedPath)) {
          genError("Cannot redefine existing key '" + path + "'.", off);
        }
        assignedPaths.add(quotedPath);
        explicitTablePaths.add(quotedPath);
        context = deepRef(data, path, createTable(), off);
        currentPath = path;
      }
      function addTableArray(node) {
        var path = node.value;
        var quotedPath = path.map(quoteDottedString).join(".");
        var off = node.offset;
        if (valueAssignments.has(quotedPath)) {
          genError("Cannot append to statically defined array '" + quotedPath + "'.", off);
        }
        assignedPaths.forEach(function(p) {
          if (isSameOrSubPath(p, quotedPath)) assignedPaths.delete(p);
        });
        valueAssignments.forEach(function(p) {
          if (isSameOrSubPath(p, quotedPath)) valueAssignments.delete(p);
        });
        assignedPaths.add(quotedPath);
        context = deepRef(data, path, createTableArray(), off);
        currentPath = path;
        if (context instanceof Array) {
          var newObj = createTable();
          context.push(newObj);
          context = newObj;
        } else {
          genError("Cannot redefine existing key '" + path + "'.", off);
        }
      }
      function deepRef(start, keys, value, off) {
        var ctx = start;
        for (var i = 0; i < keys.length; i++) {
          var key2 = keys[i];
          var traversedPath = pathKey(keys.slice(0, i + 1));
          if (typeof ctx[key2] === "undefined") {
            if (i === keys.length - 1) {
              ctx[key2] = value;
            } else {
              ctx[key2] = createTable();
            }
          } else if (i !== keys.length - 1 && valueAssignments.has(traversedPath)) {
            genError("Cannot redefine existing key '" + traversedPath + "'.", off);
          }
          ctx = ctx[key2];
          if (i < keys.length - 1) {
            if (!isOwnedContainer(ctx)) {
              genError("Cannot redefine existing key '" + traversedPath + "'.", off);
            }
            if (ctx instanceof Array) {
              if (!ctx.length) {
                genError("Cannot redefine existing key '" + traversedPath + "'.", off);
              }
              ctx = ctx[ctx.length - 1];
              if (!isOwnedContainer(ctx)) {
                genError("Cannot redefine existing key '" + traversedPath + "'.", off);
              }
            }
          }
        }
        return ctx;
      }
      function reduceArray(array) {
        return array.map(reduceValueNode);
      }
      function quoteDottedString(str) {
        if (str.indexOf(".") > -1) {
          return '"' + str + '"';
        } else {
          return str;
        }
      }
      function createTable() {
        var table2 = /* @__PURE__ */ Object.create(null);
        ownedContainers.add(table2);
        return table2;
      }
      function createTableArray() {
        var tableArray = [];
        ownedContainers.add(tableArray);
        return tableArray;
      }
      function isOwnedContainer(value) {
        return value !== null && typeof value === "object" && ownedContainers.has(value);
      }
      function pathKey(keys) {
        return keys.map(quoteDottedString).join(".");
      }
      function makeFullPath(keys) {
        return pathKey(currentPath.concat(keys));
      }
      function isSameOrSubPath(path, prefix) {
        return path === prefix || path.indexOf(prefix + ".") === 0;
      }
    }
    module.exports = {
      compile
    };
  }
});

// sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/index.js
var require_toml = __commonJS({
  "sdk/node_modules/.pnpm/toml@4.2.0/node_modules/toml/index.js"(exports, module) {
    var parser = require_parser();
    var compiler = require_compiler();
    module.exports = {
      parse: function(input, options) {
        var str = input.toString();
        var nodes = parser.parse(str, options);
        return compiler.compile(nodes, str);
      }
    };
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/workspace.js
var require_workspace = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/workspace.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.resolveIdlFileName = void 0;
    var fs = __importStar(__require("fs"));
    var path = __importStar(__require("path"));
    var toml = __importStar(require_toml());
    var child_process_1 = __require("child_process");
    var index_js_1 = require_program();
    var common_js_1 = require_common();
    var case_js_1 = require_case();
    var cargoTargetDirectoryCache;
    function resolveIdlFileName(idlDirPath, programName) {
      let dirEntries;
      try {
        dirEntries = fs.readdirSync(idlDirPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          throw new Error(`IDL directory not found at \`${idlDirPath}\`. Did you run \`anchor build\`?`);
        }
        throw err;
      }
      const jsonFiles = dirEntries.filter((name) => path.extname(name) === ".json" && fs.statSync(path.join(idlDirPath, name)).isFile());
      const fileName = jsonFiles.find((name) => (0, case_js_1.toCamelCase)(path.parse(name).name) === programName);
      if (!fileName) {
        if (jsonFiles.length === 0) {
          throw new Error(`No IDL files found in \`${idlDirPath}\`. Did you run \`anchor build\`?`);
        }
        const available = jsonFiles.map((n) => path.parse(n).name).sort().join(", ");
        throw new Error(`Failed to find IDL for program \`${programName}\`.
Available programs in \`${idlDirPath}\`: ${available}
Ensure the following all use the same snake_case name:
  - \`[lib].name\` in Cargo.toml
  - \`#[program]\` module name in your Rust program
  - Program key in Anchor.toml under \`[programs.<cluster>]\``);
      }
      return fileName;
    }
    exports.resolveIdlFileName = resolveIdlFileName;
    function getCargoTargetDirectory() {
      if (cargoTargetDirectoryCache !== void 0) {
        return cargoTargetDirectoryCache;
      }
      let metadata;
      try {
        const output = (0, child_process_1.execSync)("cargo metadata --no-deps --format-version=1", {
          encoding: "utf8"
        });
        metadata = JSON.parse(output);
      } catch (err) {
        throw new Error(`Failed to run 'cargo metadata'. Ensure Rust and Cargo are installed and the project is valid.
Original error: ${err instanceof Error ? err.message : err}`);
      }
      cargoTargetDirectoryCache = metadata.target_directory;
      return cargoTargetDirectoryCache;
    }
    var workspace = new Proxy({}, {
      get(workspaceCache, programName) {
        var _a, _b;
        if (common_js_1.isBrowser) {
          throw new Error("Workspaces aren't available in the browser");
        }
        programName = (0, case_js_1.toCamelCase)(programName);
        if (workspaceCache[programName])
          return workspaceCache[programName];
        const anchorToml = toml.parse(fs.readFileSync("Anchor.toml", "utf8"));
        const clusterId = anchorToml.provider.cluster;
        const programs = (_a = anchorToml.programs) === null || _a === void 0 ? void 0 : _a[clusterId];
        let programEntry;
        if (programs) {
          programEntry = (_b = Object.entries(programs).find(([key2]) => (0, case_js_1.toCamelCase)(key2) === programName)) === null || _b === void 0 ? void 0 : _b[1];
        }
        let idlPath;
        let programId;
        if (typeof programEntry === "object" && programEntry.idl) {
          idlPath = programEntry.idl;
          programId = programEntry.address;
        } else {
          const idlDirPath = path.join(getCargoTargetDirectory(), "idl");
          const fileName = resolveIdlFileName(idlDirPath, programName);
          idlPath = path.join(idlDirPath, fileName);
        }
        if (!fs.existsSync(idlPath)) {
          throw new Error(`${idlPath} doesn't exist. Did you run \`anchor build\`?`);
        }
        const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
        if (programId) {
          idl.address = programId;
        }
        workspaceCache[programName] = new index_js_1.Program(idl);
        return workspaceCache[programName];
      }
    });
    exports.default = workspace;
  }
});

// sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/index.js
var require_cjs = __commonJS({
  "sdk/node_modules/.pnpm/@anchor-lang+core@1.2.1_bufferutil@4.1.0_typescript@5.9.2/node_modules/@anchor-lang/core/dist/cjs/index.js"(exports) {
    "use strict";
    var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    }) : (function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    }));
    var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    }) : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports && exports.__importStar || function(mod) {
      if (mod && mod.__esModule) return mod;
      var result = {};
      if (mod != null) {
        for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
      }
      __setModuleDefault(result, mod);
      return result;
    };
    var __exportStar = exports && exports.__exportStar || function(m, exports2) {
      for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports2, p)) __createBinding(exports2, m, p);
    };
    var __importDefault = exports && exports.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.utils = exports.AnchorProvider = exports.setProvider = exports.getProvider = exports.web3 = exports.BN = void 0;
    var nodewallet_1 = __importDefault(require_nodewallet());
    var common_js_1 = require_common();
    var bn_js_1 = require_bn();
    Object.defineProperty(exports, "BN", { enumerable: true, get: function() {
      return __importDefault(bn_js_1).default;
    } });
    exports.web3 = __importStar(__require("@solana/web3.js"));
    var provider_js_1 = require_provider();
    Object.defineProperty(exports, "getProvider", { enumerable: true, get: function() {
      return provider_js_1.getProvider;
    } });
    Object.defineProperty(exports, "setProvider", { enumerable: true, get: function() {
      return provider_js_1.setProvider;
    } });
    Object.defineProperty(exports, "AnchorProvider", { enumerable: true, get: function() {
      return provider_js_1.AnchorProvider;
    } });
    __exportStar(require_error(), exports);
    __exportStar(require_idl(), exports);
    __exportStar(require_coder(), exports);
    exports.utils = __importStar(require_utils2());
    __exportStar(require_program(), exports);
    __exportStar(require_native(), exports);
    if (!common_js_1.isBrowser) {
      exports.workspace = require_workspace().default;
      exports.Wallet = require_nodewallet().default;
    }
  }
});

// sdk/packages/sdk/src/integration.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire as createRequire2 } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { AddressLookupTableAccount, PublicKey as PublicKey7 } from "@solana/web3.js";

// sdk/packages/shared/src/programs.ts
var PROGRAM_IDS = {
  token: "554tgVzsJ6NvQFpKc39HV73EDdarx3PMyDJTohcvHMLJ",
  swap: "3yJKNHzDC7JA979RJNqxKSyo1jt6kLcJNk9bjUuebLN2",
  bridge: "GXeSHtaGgb68LPsDzrYRfmup3afPsZUHefG2usnu7sgs",
  launch: "4CxedXkUfo6JLXSnzuxr2XA9xeXPsxQeR1xeTedhKMyd",
  taxHook: "8KoeKiwydKzdH65uD4Z6uJgR9uKnj2w22HXRSdCXGhF2",
  /** The v2 token-rules hook (docs/hooks-v2.md §4): holder rewards, max wallet and the two locks. */
  kit: "AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm",
  /** Half-Life (programs/half_life): an exit fee that halves every six hours a token is held, burned. */
  halfLife: "3TCbABpXPA7ifs2Fge5j1XCbXNSHMdLHEXNMxuMAC6Ub",
  /** Companions (programs/bordrless_companion, docs/companions.md): a launch whose creator is a program, its fees bought back, shared with holders or vested by code. */
  companion: "C2Xn1VnKs43XH97KAb41Q5ns57XgT4Gj8vSz3J52DS7X",
  /**
   * The lottery hook (programs/lottery_hook, docs/companions.md "Games"): a lottery coin's token
   * hook under the game ticket standard; its companion holds the pot and draws. Deployed on
   * devnet, but lottery creation is disabled in the beta launcher pending keeper support.
   */
  lotteryHook: "AGueGATrMsXJdrwocv1ktN5CZac8VSh6pinpcZNGPsmE",
  /**
   * `hook_timelock` (phase 3a, bordrless-programs docs/phase3a.md §3): a hook's or a strategy's
   * upgrade authority behind a public delay of at least 3 days; its only exit is "immutable". Not
   * deployed yet (2026-10-09).
   */
  hookTimelock: "EacWdkbLjXqMzoFXaZ8pLSoL1sy6yKvbVduNKLcE4H3F",
  /**
   * `hook_vault` (phase 3a, §5): where a hook's cuts go, each slot with a policy fixed before the
   * launch (burn, sell for SOL to a fixed wallet, sell and buy-and-burn another token), run by a
   * permissionless crank under the companion's buyback guards. Not deployed yet (2026-10-09).
   */
  hookVault: "4fuUfnezxUTbme1xnv7jTCV1DeSK3iWF6ZqkyoTes9iK"
};
var LOTTERY_HOOK = {
  program: PROGRAM_IDS.lotteryHook,
  flags: 145,
  tokenHookSigner: "FNcciFTUaGN7SpzfEhd65WdpV7zr1BNC6KDoVPcdvqiK",
  hookAuthority: "FNwUq15UcsNzmvuyGSpEvzk4wnCWVXBwgFu72WRdKaZh",
  readme: "https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/lottery_hook",
  /** No lottery launch configs are supported in this beta; upstream mainnet IDs do not apply. */
  launchConfigs: {}
};
var HALF_LIFE = {
  program: PROGRAM_IDS.halfLife,
  /** `BEFORE_TRANSFER | TRANSFER_RETURNS_DELTA | WRITES_HOOK_DATA`. */
  flags: 193,
  creatorFeeBps: 100,
  maxFeePpm: 2e5,
  halfLifeSecs: 21600,
  zeroAfterSecs: 172800,
  /** The token program's signer of the hook's callbacks (`["hook-authority", half_life]`). */
  tokenHookSigner: "5QizDzwGoYhHy1rNzkUwTEEmq1TjNt8qp5K4dy85VkWY",
  readme: "https://github.com/BordrlessDex/bordrless-programs/tree/main/programs/half_life"
};
var NATIVE_MINT = "So11111111111111111111111111111111111111112";
var SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
var ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
var COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
var HOOK_SIGNERS = {
  /** The token program's signer of the kit's callbacks (bump 254). */
  tokenForKit: "85WvnBpyyFQ7JDUUcQAi5xSz6uBuVejZtFb2anejxDSw",
  /** The token program's signer of `tax_hook`'s callbacks (bump 255). */
  tokenForTaxHook: "B9GeJe1ohzPYyLR3dQXsiJDHyH4rKUPNebqWBLRJfxMc",
  /** The DEX's signer of the launch's pool callbacks (bump 252). */
  dexForLaunch: "Eko1BNBf8vqswCgvHeUmquof6FDWproVYDuTL72Hecwu"
};
var FIXED_ADDRESSES = {
  /** `["__event_authority"]` under the token program. */
  tokenEventAuthority: "Hrnb5GMms3ZFRjoXTxMbHgJfutguW3w2MmhiqR57FzkT",
  /** `["__event_authority"]` under the DEX. */
  swapEventAuthority: "4gMrbTRhWQBxvwdJpSpwT8dGYewHTXtDxvvPyAfxJi9u",
  /** `["config"]` under the DEX. */
  swapConfig: "DwreHPxauoKagHpAfTn7Fhgv4oF3HXZR9jkc95WJA1Sq",
  /** `["__event_authority"]` under the bridge. */
  bridgeEventAuthority: "H6n1scymR545XbFMRjh6o76ti8N6SRRRdYNYtK4NG4Ec",
  /** `["config"]` under the bridge. */
  bridgeConfig: "8EpYMnpU5Gjpne4SEaqjDVwxUidyp8SpYZ7tb42t9eTy",
  /** `["wrapper", NATIVE_MINT]` under the bridge. */
  solWrapper: "H8zfmwGp3MMBdEhu2ctVeqzzsb7utZq5WhZwpKS1gxQC",
  /** `["sol-vault"]` under the bridge: the lamports behind bridged SOL. */
  solVault: "AegRC8wSVAZLmn7Z6zCza2wkyU2u42YMqsNXrm6tDcjk",
  /** `["wrapped", NATIVE_MINT]` under the bridge: bridged SOL, the quote of every launch (no hook). */
  bridgedSolMint: "9815kDrx6sNiXCnD2CvB8LKNJjbdKWmQYXzH5gYKABSq",
  /** `["__event_authority"]` under the launchpad. */
  launchEventAuthority: "31geagUs9izo9nZDSi5hci7Re2taq7KaGZQKX7kweMHa",
  /** `["hook-authority"]` under the launchpad: it creates launch pools and finalizes their curves. */
  launchHookAuthority: "49cEu8QaZAQBUhHjLjvYVTaLSw8vxMgfaht8EizMA4S2",
  /** `["config"]` under the launchpad. */
  launchConfig: "9zgdTbrkxPjUrHXts51X5tZmMqcNzLpit1WaXmkeRnMU",
  /** `["__event_authority"]` under the kit. */
  kitEventAuthority: "2armrj8J3DygJa48aiUqb3KuxfnYG2RAs11jJLMeXfhm",
  /** `["hook-authority"]` under the kit: it signs the token program's `write_hook_data` in `claim`. */
  kitHookAuthority: "6fsYyQXD3C2bk1CUQ3xZQnvbs2gyhRtFF4uo7JuXFPf1",
  /** `["__event_authority"]` under the companion program. */
  companionEventAuthority: "k7FDWYLXuxAXFsGC7pK4N6R1vEueXAUhD4osTeTZgv6"
};
var PROTOCOL_LOOKUP_TABLE_ADDRESSES = [
  FIXED_ADDRESSES.tokenEventAuthority,
  HOOK_SIGNERS.tokenForKit,
  FIXED_ADDRESSES.swapEventAuthority,
  HOOK_SIGNERS.dexForLaunch,
  FIXED_ADDRESSES.swapConfig,
  FIXED_ADDRESSES.bridgeEventAuthority,
  FIXED_ADDRESSES.bridgeConfig,
  FIXED_ADDRESSES.solWrapper,
  FIXED_ADDRESSES.solVault,
  FIXED_ADDRESSES.launchEventAuthority,
  FIXED_ADDRESSES.launchHookAuthority,
  FIXED_ADDRESSES.launchConfig,
  FIXED_ADDRESSES.kitEventAuthority,
  FIXED_ADDRESSES.kitHookAuthority,
  PROGRAM_IDS.kit,
  FIXED_ADDRESSES.bridgedSolMint,
  SYSTEM_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  // Appended 2026-10-08 for launches through a companion (docs/companions.md): the companion's event
  // authority and the programs it invokes, so its launch transaction fits (1,142 bytes instead of 1,266).
  FIXED_ADDRESSES.companionEventAuthority,
  PROGRAM_IDS.launch,
  PROGRAM_IDS.swap,
  PROGRAM_IDS.token
];
var TOKEN_HOOK_FLAGS = {
  BEFORE_TRANSFER: 1 << 0,
  AFTER_TRANSFER: 1 << 1,
  BEFORE_MINT: 1 << 2,
  AFTER_MINT: 1 << 3,
  BEFORE_BURN: 1 << 4,
  AFTER_BURN: 1 << 5,
  TRANSFER_RETURNS_DELTA: 1 << 6,
  /** v2: the hook may write the 64 bytes of hook data each holding keeps. */
  WRITES_HOOK_DATA: 1 << 7
};
var POOL_HOOK_FLAGS = {
  BEFORE_INITIALIZE: 1 << 0,
  AFTER_INITIALIZE: 1 << 1,
  BEFORE_ADD_LIQUIDITY: 1 << 2,
  AFTER_ADD_LIQUIDITY: 1 << 3,
  BEFORE_REMOVE_LIQUIDITY: 1 << 4,
  AFTER_REMOVE_LIQUIDITY: 1 << 5,
  BEFORE_SWAP: 1 << 6,
  AFTER_SWAP: 1 << 7,
  /** v2: also allows the answer's `burn`. */
  BEFORE_SWAP_RETURNS_DELTA: 1 << 8,
  /** v2: also allows the answer's `burn`. */
  AFTER_SWAP_RETURNS_DELTA: 1 << 9,
  BEFORE_SWAP_OVERRIDES_FEE: 1 << 10
};
var LAUNCH_POOL_HOOK_FLAGS = POOL_HOOK_FLAGS.BEFORE_INITIALIZE | POOL_HOOK_FLAGS.BEFORE_SWAP | POOL_HOOK_FLAGS.AFTER_SWAP | POOL_HOOK_FLAGS.BEFORE_SWAP_RETURNS_DELTA | POOL_HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA | POOL_HOOK_FLAGS.BEFORE_SWAP_OVERRIDES_FEE;

// sdk/packages/shared/src/policy.ts
var WAD = 10n ** 18n;
var U64_MAX = (1n << 64n) - 1n;
var U128_MAX = (1n << 128n) - 1n;
var TOKEN_SUPPLY = 1000000000n * 1000000n;
var DAY_SECS = 86400;
var RULE_BOUNDS = {
  maxHolderFeeBps: 200,
  maxBurnBps: 100,
  maxRulesFeeBps: 300,
  minMaxWalletBps: 100,
  maxMaxWalletBps: 500,
  maxCreatorLockSecs: 90 * DAY_SECS,
  maxEarlyWindowSecs: 300,
  maxEarlyLockSecs: 7 * DAY_SECS
};
var RULE_CEILINGS = {
  maxHolderFeeBps: 500,
  maxBurnBps: 500,
  maxRulesFeeBps: 1e3,
  minMaxWalletBps: 1,
  maxMaxWalletBps: 9999,
  maxCreatorLockSecs: 365 * DAY_SECS,
  maxEarlyWindowSecs: 3600,
  maxEarlyLockSecs: 30 * DAY_SECS
};
var NO_RULES = { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockDays: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };
var DEFAULT_RULES = { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 200, creatorLockDays: 30 };
var RULE_PRESETS = [
  { name: "Plain", slug: "plain", description: "No token rules; the creator fee and the sniper fee every launch has.", creatorFeeBps: 100, rules: NO_RULES },
  {
    name: "Diamond hands",
    slug: "diamond-hands",
    description: "Early-buyer lock (the first 5 min, until 24 h after launch), max wallet 1%, creator wallet lock 90 d, holder rewards 1%, creator fee 0.5%.",
    creatorFeeBps: 50,
    rules: { ...NO_RULES, holderFeeBuyBps: 100, holderFeeSellBps: 100, maxWalletBps: 100, creatorLockDays: 90, earlyWindowSecs: 300, earlyLockSecs: 86400 }
  },
  { name: "Burn", slug: "burn", description: "Burn 0.5% on buys and sells, holder rewards 0.5%, creator fee 0.5%.", creatorFeeBps: 50, rules: { ...NO_RULES, holderFeeBuyBps: 50, holderFeeSellBps: 50, burnBuyBps: 50, burnSellBps: 50 } },
  { name: "Paid to hold", slug: "paid-to-hold", description: "Holder rewards 2% on sells only, creator wallet lock 30 d, creator fee 0.5%.", creatorFeeBps: 50, rules: { ...NO_RULES, holderFeeSellBps: 200, creatorLockDays: 30 } }
];
var LOTTERY_LIMITS = {
  minRoundSecs: 3600,
  maxRoundSecs: 30 * DAY_SECS,
  minMinPotLamports: 100000000n,
  maxMinPotLamports: 1000000000000n,
  minPrizeBps: 1e3,
  minClaimWindowSecs: 300,
  maxClaimWindowSecs: DAY_SECS,
  maxAttempts: 16,
  claimsPerRound: 2,
  /** The most a pot holds while its hook is not audited: 10 SOL, the rest of the pot's share bought back. */
  potCapLamports: 10000000000n,
  /** Lamports the setup pays for the hook's state and registry and the game's account (mainnet rent, 2026-10-08). */
  rentLamports: 3515360n + 3119120n
};
var LOTTERY_ROUND_CHOICES = [
  { secs: 3600, label: "1 hour" },
  { secs: 21600, label: "6 hours" },
  { secs: DAY_SECS, label: "1 day" },
  { secs: 7 * DAY_SECS, label: "7 days" }
];
var LOTTERY_COPY = {
  held: "The pot is held by the companion program and paid out by code. Randomness by ORAO VRF.",
  odds: "Your odds = your tokens in the round. Sell before the payout and you forfeit.",
  stop: "Bordrless can stop this game: its pot would be bought back and burned. Nobody is paid.",
  cap: "Pot capped at 10 SOL until the game\u2019s hook is audited.",
  oracle: "Randomness by ORAO VRF: ORAO\u2019s three signers produce it. They could withhold or bias a draw; Bordrless can\u2019t."
};
var GAME_KIND_LIMITS = { minTimerSecs: 300, maxTimerSecs: 30 * DAY_SECS, maxMinStreakSecs: 365 * DAY_SECS };
var JACKPOT_COPY = {
  held: "The pot is held by the companion program and paid out by code. No randomness: the last buyer wins.",
  rule: "The last buyer wins if they keep every token they bought: any sale or transfer forfeits.",
  unfunded: "If the pot is below its minimum when a round is settled, the round pays nothing and the pot carries on.",
  curve: "Buys count while the coin is on its curve: the jackpot ends at graduation (the round under way is still paid).",
  cap: LOTTERY_COPY.cap,
  stop: LOTTERY_COPY.stop
};
var STREAK_COPY = {
  held: "The pot is held by the companion program and paid out by code. No randomness: holders share in proportion to what they held.",
  rule: "Send anything, to anyone, and you lose this epoch\u2019s and last epoch\u2019s share. Claim before you sell.",
  weight: "Your weight is what you held since the epoch began: tokens that arrive during an epoch count from the next.",
  claims: "Shares are claimed during the next epoch; the keeper claims for everyone whose share covers the fee, the rest claim here. What is not claimed rolls over.",
  cap: LOTTERY_COPY.cap,
  stop: LOTTERY_COPY.stop
};
var SCALE = 10n ** 12n;
var MIN_ELIGIBLE_DIVISOR = 1000n;
var minEligibleFor = (supply) => supply / MIN_ELIGIBLE_DIVISOR;
var MIN_ELIGIBLE = minEligibleFor(TOKEN_SUPPLY);

// sdk/packages/shared/src/studio.ts
var CALLBACK_FLAGS = [
  ["before_transfer", TOKEN_HOOK_FLAGS.BEFORE_TRANSFER],
  ["after_transfer", TOKEN_HOOK_FLAGS.AFTER_TRANSFER],
  ["before_mint", TOKEN_HOOK_FLAGS.BEFORE_MINT],
  ["after_mint", TOKEN_HOOK_FLAGS.AFTER_MINT],
  ["before_burn", TOKEN_HOOK_FLAGS.BEFORE_BURN],
  ["after_burn", TOKEN_HOOK_FLAGS.AFTER_BURN]
];

// sdk/packages/sdk/src/addresses.ts
import { PublicKey } from "@solana/web3.js";
var TOKEN_PROGRAM = new PublicKey(PROGRAM_IDS.token);
var SWAP_PROGRAM = new PublicKey(PROGRAM_IDS.swap);
var BRIDGE_PROGRAM = new PublicKey(PROGRAM_IDS.bridge);
var LAUNCH_PROGRAM = new PublicKey(PROGRAM_IDS.launch);
var KIT_PROGRAM = new PublicKey(PROGRAM_IDS.kit);
var TAX_HOOK_PROGRAM = new PublicKey(PROGRAM_IDS.taxHook);
var HALF_LIFE_PROGRAM = new PublicKey(PROGRAM_IDS.halfLife);
var COMPANION_PROGRAM = new PublicKey(PROGRAM_IDS.companion);
var LOTTERY_HOOK_PROGRAM = new PublicKey(PROGRAM_IDS.lotteryHook);
var HOOK_TIMELOCK_PROGRAM = new PublicKey(PROGRAM_IDS.hookTimelock);
var HOOK_VAULT_PROGRAM = new PublicKey(PROGRAM_IDS.hookVault);
var SYSTEM_PROGRAM = new PublicKey(SYSTEM_PROGRAM_ID);
var SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
var SPL_TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
var ATA_PROGRAM = new PublicKey(ASSOCIATED_TOKEN_PROGRAM_ID);
var NATIVE_MINT_KEY = new PublicKey(NATIVE_MINT);
var COMPUTE_BUDGET_PROGRAM = new PublicKey(COMPUTE_BUDGET_PROGRAM_ID);
var BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
var ADDRESS_LOOKUP_TABLE_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");
var enc = (s) => Buffer.from(s, "utf8");
var pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];
var memo = /* @__PURE__ */ new Map();
var cached = (key2, make) => {
  let v = memo.get(key2);
  if (!v) {
    v = make();
    memo.set(key2, v);
  }
  return v;
};
var hookAuthority = (program) => cached(`ha:${program.toBase58()}`, () => pda([enc("hook-authority")], program));
var eventAuthority = (program) => cached(`ea:${program.toBase58()}`, () => pda([enc("__event_authority")], program));
var configAddress = (program) => cached(`cfg:${program.toBase58()}`, () => pda([enc("config")], program));
var programDataAddress = (program) => pda([program.toBuffer()], BPF_LOADER_UPGRADEABLE);
var TOKEN_EVENT_AUTHORITY = eventAuthority(TOKEN_PROGRAM);
var SWAP_EVENT_AUTHORITY = eventAuthority(SWAP_PROGRAM);
var BRIDGE_EVENT_AUTHORITY = eventAuthority(BRIDGE_PROGRAM);
var LAUNCH_EVENT_AUTHORITY = eventAuthority(LAUNCH_PROGRAM);
var KIT_EVENT_AUTHORITY = eventAuthority(KIT_PROGRAM);
var tokenHookSigner = (hookProgram) => cached(`ths:${hookProgram.toBase58()}`, () => pda([enc("hook-authority"), hookProgram.toBuffer()], TOKEN_PROGRAM));
var TOKEN_HOOK_SIGNER_KIT = new PublicKey(HOOK_SIGNERS.tokenForKit);
var TOKEN_HOOK_SIGNER_TAX_HOOK = new PublicKey(HOOK_SIGNERS.tokenForTaxHook);
var DEX_HOOK_SIGNER_LAUNCH = new PublicKey(HOOK_SIGNERS.dexForLaunch);
var SWAP_CONFIG = configAddress(SWAP_PROGRAM);
var BRIDGE_CONFIG = configAddress(BRIDGE_PROGRAM);
var SOL_VAULT = pda([enc("sol-vault")], BRIDGE_PROGRAM);
var wrapperAddress = (underlying) => pda([enc("wrapper"), underlying.toBuffer()], BRIDGE_PROGRAM);
var wrappedMintAddress = (underlying) => pda([enc("wrapped"), underlying.toBuffer()], BRIDGE_PROGRAM);
var BRIDGED_SOL_MINT = wrappedMintAddress(NATIVE_MINT_KEY);
var SOL_WRAPPER = wrapperAddress(NATIVE_MINT_KEY);
var LAUNCH_CONFIG = configAddress(LAUNCH_PROGRAM);
var LAUNCH_HOOK_AUTHORITY = hookAuthority(LAUNCH_PROGRAM);
var KIT_HOOK_AUTHORITY = hookAuthority(KIT_PROGRAM);
var PROTOCOL_LOOKUP_TABLE = PROTOCOL_LOOKUP_TABLE_ADDRESSES.map((a) => new PublicKey(a));
var COMPANION_EVENT_AUTHORITY = pda([enc("__event_authority")], COMPANION_PROGRAM);
var COMPANION_PROGRAM_DATA = programDataAddress(COMPANION_PROGRAM);
var TOKEN_HOOK_SIGNER_LOTTERY = tokenHookSigner(LOTTERY_HOOK_PROGRAM);
var LOTTERY_HOOK_AUTHORITY = hookAuthority(LOTTERY_HOOK_PROGRAM);
var LOTTERY_EVENT_AUTHORITY = eventAuthority(LOTTERY_HOOK_PROGRAM);
var INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");
var SLOT_HASHES_SYSVAR = new PublicKey("SysvarS1otHashes111111111111111111111111111");
var ORAO_VRF_PROGRAM = new PublicKey("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
var ORAO_NETWORK_STATE = new PublicKey("5ER1oENnV4srxYdAynUfRzWeQCPQaqMiAp4VqyMbSqnK");

// sdk/packages/sdk/src/accounts.ts
var import_bn = __toESM(require_bn(), 1);
import { PublicKey as PublicKey2 } from "@solana/web3.js";

// sdk/packages/sdk/src/coders.ts
var import_core = __toESM(require_cjs(), 1);
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var { BorshCoder, convertIdlToCamelCase } = import_core.default;
var IDL = {
  token: require2("../idl/bordrless_token.json"),
  swap: require2("../idl/bordrless_swap.json"),
  bridge: require2("../idl/bordrless_bridge.json"),
  launch: require2("../idl/bordrless_launch.json"),
  kit: require2("../idl/bordrless_kit.json"),
  taxHook: require2("../idl/tax_hook.json"),
  halfLife: require2("../idl/half_life.json"),
  companion: require2("../idl/bordrless_companion.json"),
  lotteryHook: require2("../idl/lottery_hook.json"),
  hookTimelock: require2("../idl/hook_timelock.json"),
  hookVault: require2("../idl/hook_vault.json")
};
function coder(idl) {
  return new BorshCoder(convertIdlToCamelCase(idl));
}
var CODERS = {
  token: coder(IDL.token),
  swap: coder(IDL.swap),
  bridge: coder(IDL.bridge),
  launch: coder(IDL.launch),
  kit: coder(IDL.kit),
  taxHook: coder(IDL.taxHook),
  halfLife: coder(IDL.halfLife),
  companion: coder(IDL.companion),
  lotteryHook: coder(IDL.lotteryHook),
  hookTimelock: coder(IDL.hookTimelock),
  hookVault: coder(IDL.hookVault)
};

// sdk/packages/sdk/src/accounts.ts
var big = (v) => v instanceof import_bn.default ? BigInt(v.toString(10)) : typeof v === "bigint" ? v : BigInt(v);
var int = (v) => Number(big(v));
var key = (v) => v instanceof PublicKey2 ? v : new PublicKey2(v);
var optKey = (v) => v === null || v === void 0 ? null : key(v);
var NO_LAUNCH_RULES = { holderFeeBuyBps: 0, holderFeeSellBps: 0, burnBuyBps: 0, burnSellBps: 0, maxWalletBps: 0, creatorLockSecs: 0, earlyWindowSecs: 0, earlyLockSecs: 0 };
function decode(program, name, data) {
  return CODERS[program].accounts.decode(name, data);
}
var decodeMint = (data) => {
  const r = decode("token", "mint", data);
  return {
    version: Number(r.version),
    decimals: Number(r.decimals),
    supply: big(r.supply),
    maxSupply: big(r.maxSupply),
    mintAuthority: optKey(r.mintAuthority),
    freezeAuthority: optKey(r.freezeAuthority),
    hookAuthority: optKey(r.hookAuthority),
    metadataAuthority: optKey(r.metadataAuthority),
    hookProgram: optKey(r.hookProgram),
    hookFlags: Number(r.hookFlags),
    name: String(r.name),
    symbol: String(r.symbol),
    uri: String(r.uri),
    createdAt: int(r.createdAt),
    creator: key(r.creator),
    hookSignerBump: Number(r.hookSignerBump)
  };
};
var decodeSwapConfig = (data) => {
  const r = decode("swap", "config", data);
  return { admin: key(r.admin), protocolFeeBps: Number(r.protocolFeeBps), feeCollector: key(r.feeCollector), treasury: key(r.treasury), poolCreationFeeLamports: big(r.poolCreationFeeLamports), paused: Boolean(r.paused), poolsCreated: big(r.poolsCreated), launchProtocolShareBps: Number(r.launchProtocolShareBps) };
};
var decodeBridgeConfig = (data) => {
  const r = decode("bridge", "config", data);
  return { admin: key(r.admin), paused: Boolean(r.paused), wrappers: big(r.wrappers) };
};
var decodeWrapper = (data) => {
  const r = decode("bridge", "wrapper", data);
  return { bump: Number(r.bump), native: Boolean(r.native), underlyingMint: key(r.underlyingMint), underlyingProgram: key(r.underlyingProgram), wrappedMint: key(r.wrappedMint), vault: key(r.vault), decimals: Number(r.decimals), totalWrapped: big(r.totalWrapped), registeredAt: int(r.registeredAt), registrar: key(r.registrar) };
};
var ruleBounds = (v) => {
  const r = v;
  return {
    maxHolderFeeBps: Number(r.maxHolderFeeBps),
    maxBurnBps: Number(r.maxBurnBps),
    maxRulesFeeBps: Number(r.maxRulesFeeBps),
    minMaxWalletBps: Number(r.minMaxWalletBps),
    maxMaxWalletBps: Number(r.maxMaxWalletBps),
    maxCreatorLockSecs: Number(r.maxCreatorLockSecs),
    maxEarlyWindowSecs: Number(r.maxEarlyWindowSecs),
    maxEarlyLockSecs: Number(r.maxEarlyLockSecs)
  };
};
var decodeLaunchConfig = (data) => {
  const r = decode("launch", "config", data);
  return {
    admin: key(r.admin),
    treasury: key(r.treasury),
    quoteMint: key(r.quoteMint),
    launchFeeLamports: big(r.launchFeeLamports),
    lpFeeBps: Number(r.lpFeeBps),
    maxCreatorFeeBps: Number(r.maxCreatorFeeBps),
    sniperWindowSecs: int(r.sniperWindowSecs),
    sniperStartBps: Number(r.sniperStartBps),
    curveBps: Number(r.curveBps),
    supply: big(r.supply),
    decimals: Number(r.decimals),
    minVirtualQuote: big(r.minVirtualQuote),
    maxVirtualQuote: big(r.maxVirtualQuote),
    paused: Boolean(r.paused),
    launches: big(r.launches),
    ruleBounds: ruleBounds(r.ruleBounds)
  };
};

// sdk/packages/sdk/src/authority.ts
import { createHash } from "node:crypto";
import { PublicKey as PublicKey3 } from "@solana/web3.js";
var BPF_LOADER_2 = new PublicKey3("BPFLoader2111111111111111111111111111111111");
var LOADER_V4 = new PublicKey3("LoaderV411111111111111111111111111111111111");
var MIN_TIMELOCK_DELAY_SECS = 3 * 86400;
var MAX_TIMELOCK_DELAY_SECS = 365 * 86400;
var TIMELOCK_DISCRIMINATOR = Buffer.from([189, 33, 78, 75, 205, 31, 4, 177]);
function trimmedLength(code) {
  let end = code.length;
  while (end > 0 && code[end - 1] === 0) end -= 1;
  return end;
}
var executableHash = (code) => createHash("sha256").update(code.subarray(0, trimmedLength(code))).digest("hex");

// sdk/packages/sdk/src/inspect.ts
import { Keypair, PublicKey as PublicKey6 } from "@solana/web3.js";

// sdk/packages/sdk/src/hooks.ts
import { PublicKey as PublicKey4 } from "@solana/web3.js";
var HOOK_ACCOUNTS_MAGIC = Buffer.from([2, 218, 246, 102, 44, 56, 192, 205]);

// sdk/packages/sdk/src/instructions.ts
var import_bn2 = __toESM(require_bn(), 1);
import { PublicKey as PublicKey5, TransactionInstruction } from "@solana/web3.js";
var UNWRAP_ALL = (1n << 64n) - 1n;
var TAX_HOOK_FLAGS = 1 | 1 << 6;

// sdk/packages/sdk/src/inspect.ts
var PROTOCOL_PROGRAMS = [PROGRAM_IDS.token, PROGRAM_IDS.swap, PROGRAM_IDS.bridge, PROGRAM_IDS.launch, PROGRAM_IDS.kit].map((id) => new PublicKey6(id)).concat(SYSTEM_PROGRAM, PublicKey6.default);
var PROGRAM_DATA_TAG = 3;
var OPTION_AT = 12;
function upgradeAuthorityOf(data) {
  if (data.length < OPTION_AT + 1 || data.readUInt32LE(0) !== PROGRAM_DATA_TAG) return void 0;
  const tag = data[OPTION_AT];
  if (tag === 0) return null;
  if (tag !== 1 || data.length < OPTION_AT + 33) return void 0;
  return new PublicKey6(data.subarray(OPTION_AT + 1, OPTION_AT + 33));
}

// sdk/packages/sdk/src/integration.ts
var pinned = structuredClone(createRequire2(import.meta.url)("../integration/devnet.json"));
var integrationManifest = () => structuredClone(pinned);
function integrationCompatibility(manifest) {
  return isDeepStrictEqual(manifest, pinned) ? [] : [{ code: "CONTRACT_MISMATCH", subject: "manifest", message: "Use the exact Hook Lab contract bundled with this source revision; npm SDK version alone is not compatibility." }];
}
function integrationIdlRefusals() {
  const refusals = [];
  for (const p of pinned.programs) {
    if (!p.idlPath) continue;
    try {
      const data = readFileSync(new URL(`../idl/${p.role}.json`, import.meta.url));
      if (createHash2("sha256").update(data).digest("hex") !== p.idlSha256 || JSON.parse(data.toString()).address !== p.programId)
        throw new Error("mismatch");
    } catch {
      refusals.push({ code: "IDL_MISMATCH", subject: p.role, message: "Packaged IDL is missing or differs from the pinned contract." });
    }
  }
  return refusals;
}
var jsonData = (value) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
async function inspectDevnetIntegration(connection, options) {
  const out = {
    schemaVersion: "hooklab-inspection/1",
    sourceCommit: pinned.sourceCommit,
    cluster: "devnet",
    observedSlot: null,
    commitment: "finalized",
    programs: [],
    accounts: {},
    limits: null,
    refusals: integrationCompatibility(options.manifest),
    warnings: [
      "SINGLE_KEY_CUSTODY: one key controls eight upgrades, configs, treasury and ALT.",
      "OBSERVATION_ONLY: trusted RPC snapshot, not authorization, audit, quote or guarantee of future state.",
      "ECONOMICS_REQUIRE_REVIEW: decoded fees, limits and recipients are observations, not approved budgets.",
      "LAUNCH_POOL_FEES: launch-pool LP fees go to the protocol, not external liquidity providers.",
      "CUSTOM_TOKEN_STANDARD: ordinary SPL wallet balances do not represent these holdings."
    ]
  };
  const refuse = (code, subject, message) => {
    out.refusals.push({ code, subject, message });
  };
  if (options.confirmedNetwork !== "devnet") refuse("NETWORK_CONFIRMATION_REQUIRED", "cluster", "Explicit devnet confirmation is required before RPC reads.");
  out.refusals.push(...integrationIdlRefusals());
  if (out.refusals.length) return out;
  try {
    if (await connection.getGenesisHash() !== pinned.genesisHash) {
      refuse("WRONG_GENESIS", "cluster", "RPC genesis is not Hook Lab devnet.");
      return out;
    }
    const addresses = [
      ...pinned.programs.flatMap((p) => [p.programId, ...p.programData ? [p.programData] : []]),
      ...Object.values(pinned.configs),
      pinned.quoteMint,
      pinned.solWrapper,
      pinned.lookupTable.address
    ];
    const snapshot = await connection.getMultipleAccountsInfoAndContext(addresses.map((a) => new PublicKey7(a)), { commitment: "finalized" });
    out.observedSlot = snapshot.context.slot;
    if (snapshot.value.length !== addresses.length) throw new Error("incomplete snapshot");
    const accounts = new Map(addresses.map((a, i) => [a, snapshot.value[i] ?? null]));
    for (const p of pinned.programs) {
      const account = accounts.get(p.programId);
      let binaryHash = null;
      let authority = null;
      let matches = !account && p.status === "not-deployed";
      if (p.status === "deployed" && account?.executable && account.owner.toBase58() === p.loader && account.data.length === 36 && account.data.readUInt32LE(0) === 2 && new PublicKey7(account.data.subarray(4)).toBase58() === p.programData) {
        const pd = accounts.get(p.programData);
        if (pd && !pd.executable && pd.owner.toBase58() === p.loader && pd.data.length > 45) {
          authority = upgradeAuthorityOf(pd.data)?.toBase58() ?? null;
          binaryHash = executableHash(pd.data.subarray(45));
          matches = authority === p.upgradeAuthority && binaryHash === p.binaryHash && pd.data.readBigUInt64LE(4) === BigInt(p.deploySlot) && pd.data.subarray(45, 49).equals(Buffer.from([127, 69, 76, 70]));
        }
      }
      out.programs.push({ role: p.role, programId: p.programId, status: matches ? "matched" : "refused", binaryHash, upgradeAuthority: authority });
      if (!matches) refuse("DEPLOYMENT_MISMATCH", p.role, "Presence, loader, ProgramData, executable hash, deploy slot or authority differs from the pinned deployment.");
    }
    const owned = (address, owner) => {
      const account = accounts.get(address);
      if (!account || account.executable || !account.owner.equals(owner)) throw new Error("owner or presence");
      return account;
    };
    const observe = (role, address, owner, decode2, validate) => {
      try {
        const account = owned(address, owner);
        const decoded = decode2(account.data);
        out.accounts[role] = { address, dataSha256: createHash2("sha256").update(account.data).digest("hex"), decoded: jsonData(decoded) };
        if (!validate(decoded)) throw new Error("identity or paused");
        return decoded;
      } catch {
        refuse("ACCOUNT_MISMATCH", role, "Account is missing, malformed, wrongly owned, paused, or has unexpected identities.");
        return null;
      }
    };
    const launch2 = observe("launch", pinned.configs.launch, LAUNCH_PROGRAM, decodeLaunchConfig, (v) => !v.paused && v.admin.toBase58() === pinned.admin && v.treasury.toBase58() === pinned.treasury && v.quoteMint.toBase58() === pinned.quoteMint);
    if (launch2) out.limits = { maxCreatorFeeBps: launch2.maxCreatorFeeBps, ruleBounds: launch2.ruleBounds, sniper: { startBps: launch2.sniperStartBps, windowSecs: launch2.sniperWindowSecs } };
    observe("swap", pinned.configs.swap, SWAP_PROGRAM, decodeSwapConfig, (v) => !v.paused && v.admin.toBase58() === pinned.admin && v.treasury.toBase58() === pinned.treasury && v.feeCollector.toBase58() === pinned.treasury);
    observe("bridge", pinned.configs.bridge, BRIDGE_PROGRAM, decodeBridgeConfig, (v) => !v.paused && v.admin.toBase58() === pinned.admin);
    observe("quoteMint", pinned.quoteMint, TOKEN_PROGRAM, decodeMint, (v) => v.decimals === 9 && v.hookProgram === null && v.hookFlags === 0 && v.mintAuthority?.toBase58() === pinned.solWrapper && v.freezeAuthority === null && v.hookAuthority === null && v.metadataAuthority?.toBase58() === pinned.admin);
    observe("solWrapper", pinned.solWrapper, BRIDGE_PROGRAM, decodeWrapper, (v) => v.native && v.underlyingMint.toBase58() === NATIVE_MINT && v.underlyingProgram.equals(PublicKey7.default) && v.wrappedMint.toBase58() === pinned.quoteMint && v.vault.toBase58() === pinned.solVault && v.decimals === 9);
    observe("lookupTable", pinned.lookupTable.address, ADDRESS_LOOKUP_TABLE_PROGRAM, AddressLookupTableAccount.deserialize, (v) => v.deactivationSlot === 0xffffffffffffffffn && v.authority?.toBase58() === pinned.lookupTable.authority && isDeepStrictEqual(v.addresses.map((a) => a.toBase58()), PROTOCOL_LOOKUP_TABLE_ADDRESSES));
  } catch {
    refuse("INSPECTION_UNAVAILABLE", "rpc", "Could not complete the read-only snapshot. Retry with a trusted devnet RPC; do not infer readiness.");
  }
  return out;
}

// sdk/packages/sdk/src/errors.ts
var import_core2 = __toESM(require_cjs(), 1);

// sdk/packages/sdk/src/events.ts
var import_bn3 = __toESM(require_bn(), 1);
import { PublicKey as PublicKey8 } from "@solana/web3.js";
var EVENT_IX_TAG = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
var PROGRAM_OF = /* @__PURE__ */ new Map([
  [TOKEN_PROGRAM.toBase58(), "token"],
  [SWAP_PROGRAM.toBase58(), "swap"],
  [BRIDGE_PROGRAM.toBase58(), "bridge"],
  [LAUNCH_PROGRAM.toBase58(), "launch"],
  [KIT_PROGRAM.toBase58(), "kit"],
  [TAX_HOOK_PROGRAM.toBase58(), "taxHook"],
  [HALF_LIFE_PROGRAM.toBase58(), "halfLife"]
]);
var ANY_PROGRAM_OF = new Map([...PROGRAM_OF, [COMPANION_PROGRAM.toBase58(), "companion"], [LOTTERY_HOOK_PROGRAM.toBase58(), "lotteryHook"], [HOOK_TIMELOCK_PROGRAM.toBase58(), "hookTimelock"], [HOOK_VAULT_PROGRAM.toBase58(), "hookVault"]]);
var INDEXED_EVENT_PROGRAMS = [...PROGRAM_OF.values()];

// sdk/packages/sdk/src/errors.ts
var { LangErrorCode, LangErrorMessage } = import_core2.default;
function table(idl) {
  return new Map((idl.errors ?? []).map((e) => [e.code, { name: e.name, message: e.msg ?? e.name }]));
}
var PROGRAM_ERRORS = {
  token: table(IDL.token),
  swap: table(IDL.swap),
  bridge: table(IDL.bridge),
  launch: table(IDL.launch),
  kit: table(IDL.kit),
  taxHook: table(IDL.taxHook),
  halfLife: table(IDL.halfLife),
  companion: table(IDL.companion),
  lotteryHook: table(IDL.lotteryHook),
  hookTimelock: table(IDL.hookTimelock),
  hookVault: table(IDL.hookVault)
};
var ANCHOR_ERRORS = new Map(
  Object.entries(LangErrorCode).map(([name, code]) => [code, { name, message: LangErrorMessage.get(code) ?? name }])
);

// sdk/packages/sdk/src/transactions.ts
import { AddressLookupTableAccount as AddressLookupTableAccount2, AddressLookupTableProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

// sdk/packages/sdk/src/companion.ts
var import_bn4 = __toESM(require_bn(), 1);
import { PublicKey as PublicKey13, TransactionInstruction as Ix } from "@solana/web3.js";

// sdk/packages/sdk/src/game.ts
import { PublicKey as PublicKey10 } from "@solana/web3.js";
var GAME_MAGIC = Uint8Array.from(Buffer.from("BRG1", "utf8"));
var MAX_ROUND_SECS = 30 * 86400;
var I64_MAX = (1n << 63n) - 1n;
var U64_MAX2 = (1n << 64n) - 1n;

// sdk/packages/sdk/src/gameKinds.ts
import { PublicKey as PublicKey11, TransactionInstruction as TransactionInstruction2 } from "@solana/web3.js";
var I64_MAX2 = (1n << 63n) - 1n;
var I64_MIN = -(1n << 63n);
var JACKPOT_MAGIC = Uint8Array.from(Buffer.from("BRJ1", "utf8"));
var STREAK_MAGIC = Uint8Array.from(Buffer.from("BRS1", "utf8"));
var MIN_TIMER_SECS = 300;
var MAX_TIMER_SECS = 30 * 86400;
var MAX_MIN_STREAK_SECS = 365 * 86400;

// sdk/packages/sdk/src/orao.ts
import { PublicKey as PublicKey12, TransactionInstruction as TransactionInstruction3 } from "@solana/web3.js";
var REQUEST_V2 = Buffer.from([38, 151, 209, 6, 195, 102, 28, 217]);
var NETWORK_STATE_DISCRIMINATOR = Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]);
var RANDOMNESS_V2_DISCRIMINATOR = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]);
var RANDOMNESS_V1_DISCRIMINATOR = Buffer.from([188, 96, 216, 248, 93, 94, 49, 112]);

// sdk/packages/sdk/src/companion.ts
var COMPANION_DEFAULTS = { bountyBps: 50, maxBuyback: 1000000000n, buybackInterval: 60, vestSecs: 30 * 86400 };
var ZERO_SEED = new Uint8Array(32);
var GAME_LIMITS = {
  defaultPotCap: 10000000000n,
  minPotCap: 100000000n,
  minMinPot: 100000000n,
  maxMinPot: 1000000000000n,
  minPrizeBps: 1e3,
  minClaimWindowSecs: 300,
  maxClaimWindowSecs: 86400,
  maxAttempts: 16,
  claimsPerRound: 2,
  revealSecs: 600,
  seedSlots: 3,
  dormantSecs: 30 * 86400,
  dormantRounds: 4,
  retireDormantPeriods: 2,
  maxGameHookExtras: 3,
  maxGameHookExtrasV2: 2,
  strandedSecs: 30 * 86400,
  strandedIntervals: 4,
  maxBountyBps: 100,
  minTimerSecs: MIN_TIMER_SECS,
  maxTimerSecs: MAX_TIMER_SECS,
  maxMinStreakSecs: MAX_MIN_STREAK_SECS
};
var GAME_HOOK_UPGRADE_AUTHORITIES = [new PublicKey13("FQ839ogZx5joLfez4t5SppMDTCHT5dDfy34FCyYDCBvf"), new PublicKey13("HUZSwDaS7u7bfqrrhDUjCVoi6xCVDDXZhM6snvJ3YQdG")];
var STREAK_DEFAULTS = { split: { buybackBps: 3e3, holdersBps: 0, beneficiaryBps: 0 }, potBps: 7e3, roundSecs: 7 * 86400, minPot: 100000000n, prizeBps: 1e4, claimWindowSecs: 3600, maxAttempts: 0, minStreakSecs: 7 * 86400 };
var HOOK_TERMS_DEFAULT = { audited: false, potCap: GAME_LIMITS.defaultPotCap, blocked: false };
var I64_MAX3 = (1n << 63n) - 1n;

// sdk/packages/sdk/src/lotteryHook.ts
var import_bn5 = __toESM(require_bn(), 1);
import { TransactionInstruction as TransactionInstruction4 } from "@solana/web3.js";
var LOTTERY_HOOK_FLAGS = LOTTERY_HOOK.flags;

// sdk/packages/sdk/src/timelock.ts
import { PublicKey as PublicKey15, TransactionInstruction as Ix2 } from "@solana/web3.js";
var RENT_SYSVAR = new PublicKey15("SysvarRent111111111111111111111111111111111");
var CLOCK_SYSVAR = new PublicKey15("SysvarC1ock11111111111111111111111111111111");
var HOOK_TIMELOCK_EVENT_AUTHORITY = eventAuthority(HOOK_TIMELOCK_PROGRAM);
var TIMELOCK_LIMITS = { executeWindowSecs: 30 * 86400, maxCodeLen: 2 * 1024 * 1024, minDelaySecs: 3 * 86400, maxDelaySecs: 365 * 86400 };

// sdk/packages/sdk/src/vault.ts
var import_bn6 = __toESM(require_bn(), 1);
import { PublicKey as PublicKey16, TransactionInstruction as TransactionInstruction5 } from "@solana/web3.js";
var HOOK_VAULT_EVENT_AUTHORITY = eventAuthority(HOOK_VAULT_PROGRAM);
var VAULT_LIMITS = {
  maxSlots: 3,
  maxBountyBps: 100,
  maxSellBps: 100,
  minInterval: 60,
  maxInterval: 30 * 86400,
  maxHookCutBps: 5e3,
  retireSecs: 60 * 86400,
  /** A sell waits while the price is more than this below its reference (a buy: above). */
  maxDiscountBps: 300
};

// sdk/packages/sdk/src/strategy.ts
import { PublicKey as PublicKey17 } from "@solana/web3.js";
var PLAN_DISCRIMINATOR = Buffer.from([15, 185, 45, 32, 163, 6, 216, 77]);
var ENTITLE_DISCRIMINATOR = Buffer.from([31, 197, 91, 45, 218, 96, 13, 175]);

// sdk/packages/sdk/src/risk.ts
import "@solana/web3.js";

// sdk/packages/launcher/src/plan.ts
var SETUP_LIMITS = { maxCreatorFeeBps: 500, ruleBounds: RULE_CEILINGS, sniper: { startBps: 8e3, windowSecs: 30 } };
var HALF_LIFE_CURVE = { startBps: 2e3, halfSecs: 21600, zeroSecs: 172800 };
var NOT_BUILT = {
  whale_tax: "Whale tax is not built yet: it needs a change to the launch program\u2019s pool hook.",
  gravity: "Gravity is not built yet: it needs a change to the launch program\u2019s pool hook.",
  happy_hour: "Happy hour is not built yet: it needs a change to the launch program\u2019s pool hook.",
  heist: "Heist is not built yet: it needs a change to the launch program\u2019s pool hook and a vault.",
  burn_other: "Burn another coin is not wired: the hook vault burns a hook\u2019s own cuts, not creator fees.",
  jackpot: "Last buyer wins needs its own game hook deployed for each coin. Not wired yet.",
  streak: "Diamond streak needs its own game hook deployed for each coin. Not wired yet.",
  strategy: "Custom payout needs your own strategy program. Not wired yet."
};
var FIELDS = {
  creator_fee: [],
  holder_rewards: ["buy_bps", "sell_bps"],
  burn: ["buy_bps", "sell_bps"],
  sniper_fee: ["start_bps", "secs_secs"],
  exit_halflife: ["start_bps", "half_secs", "zero_secs"],
  max_wallet: ["pct_bps"],
  creator_lock: ["days_secs"],
  early_lock: ["window_secs", "lock_secs"],
  dev_vest: ["days_secs", "buy_bps"],
  fee_split: ["bb_bps", "h_bps"],
  lottery: ["fill_bps", "round_secs"]
};
var num = (b, k) => {
  const v = b?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};
var pct = (bps) => `${+(bps / 100).toFixed(2)}%`;
var days = (secs) => `${+(secs / 86400).toFixed(2)} day${secs === 86400 ? "" : "s"}`;
var hours = (secs) => `${+(secs / 3600).toFixed(2)} hour${secs === 3600 ? "" : "s"}`;
function planFromHookLab(raw, limits = SETUP_LIMITS) {
  const problems = [];
  const notes = [];
  const steps = [];
  const cfg = raw ?? {};
  if (cfg.format !== "hook-lab/1") problems.push('This is not a Hook Lab config (format "hook-lab/1"). Copy it from the Config tab.');
  const blocks = Array.isArray(cfg.blocks) ? cfg.blocks.filter((b) => !!b && typeof b === "object" && typeof b.type === "string") : [];
  if (!Array.isArray(cfg.blocks) || blocks.length !== cfg.blocks.length) problems.push("blocks must be an array of objects with a string type; malformed blocks are not ignored.");
  const seen = /* @__PURE__ */ new Set();
  for (const b of blocks) {
    if (seen.has(b.type)) problems.push(`Duplicate block "${b.type}". Keep one block of each type.`);
    seen.add(b.type);
    const fields = b.type === "creator_fee" ? "fee_bps" in b ? ["fee_bps"] : ["buy_bps", "sell_bps"] : Object.hasOwn(FIELDS, b.type) ? FIELDS[b.type] : [];
    for (const field of fields) {
      const v = b[field];
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > (field.endsWith("_bps") ? 1e4 : 4294967295))
        problems.push(`${b.type}.${field} must be a nonnegative integer from 0 to ${field.endsWith("_bps") ? 1e4 : 4294967295}; fix the config rather than defaulting to zero.`);
    }
  }
  const by = new Map(blocks.map((b) => [b.type, b]));
  const has = (t) => by.has(t);
  const name = typeof cfg.coin?.name === "string" ? cfg.coin.name.trim().slice(0, 32) : "";
  const symbol = typeof cfg.coin?.ticker === "string" ? cfg.coin.ticker.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10) : "";
  if (typeof cfg.coin?.name !== "string" || Buffer.byteLength(cfg.coin.name.trim(), "utf8") > 32) problems.push("Coin name must be a string of at most 32 UTF-8 bytes.");
  if (typeof cfg.coin?.ticker !== "string" || !/^[A-Za-z0-9]{1,10}$/.test(cfg.coin.ticker)) problems.push("Ticker must contain 1\u201310 ASCII letters or digits.");
  if (!name) problems.push("The coin needs a name.");
  if (!symbol) problems.push("The coin needs a ticker.");
  for (const b of blocks) {
    if (Object.hasOwn(NOT_BUILT, b.type)) problems.push(NOT_BUILT[b.type]);
    else if (!["creator_fee", "holder_rewards", "burn", "sniper_fee", "exit_halflife", "max_wallet", "creator_lock", "early_lock", "dev_vest", "fee_split", "lottery"].includes(b.type)) problems.push(`Unknown block "${b.type}".`);
  }
  const cf = by.get("creator_fee");
  let creatorFeeBps = 0;
  if (cf) {
    const buy = "fee_bps" in cf ? num(cf, "fee_bps") : num(cf, "buy_bps"), sell = "fee_bps" in cf ? num(cf, "fee_bps") : num(cf, "sell_bps");
    if (buy !== sell) problems.push(`The launchpad takes one creator fee for buys and sells. Hook Lab has ${pct(buy)} on buys and ${pct(sell)} on sells: set both to the same number.`);
    creatorFeeBps = Math.max(buy, sell);
    if (creatorFeeBps > limits.maxCreatorFeeBps) problems.push(`The creator fee is ${pct(creatorFeeBps)}; the most this launchpad allows is ${pct(limits.maxCreatorFeeBps)}.`);
  }
  const rules = { ...NO_LAUNCH_RULES };
  const bnd = limits.ruleBounds;
  const hr = by.get("holder_rewards");
  if (hr) {
    rules.holderFeeBuyBps = num(hr, "buy_bps");
    rules.holderFeeSellBps = num(hr, "sell_bps");
    if (Math.max(rules.holderFeeBuyBps, rules.holderFeeSellBps) > bnd.maxHolderFeeBps) problems.push(`Holder rewards top out at ${pct(bnd.maxHolderFeeBps)} a side.`);
  }
  const bu = by.get("burn");
  if (bu) {
    rules.burnBuyBps = num(bu, "buy_bps");
    rules.burnSellBps = num(bu, "sell_bps");
    if (Math.max(rules.burnBuyBps, rules.burnSellBps) > bnd.maxBurnBps) problems.push(`Burn tops out at ${pct(bnd.maxBurnBps)} a side.`);
  }
  for (const [side, h, b] of [["buys", rules.holderFeeBuyBps, rules.burnBuyBps], ["sells", rules.holderFeeSellBps, rules.burnSellBps]]) {
    const total = creatorFeeBps + h + b;
    if (total > bnd.maxRulesFeeBps) problems.push(`Creator fee, holder rewards and burn add up to ${pct(total)} on ${side}; the most is ${pct(bnd.maxRulesFeeBps)}.`);
  }
  const mw = by.get("max_wallet");
  if (mw) {
    rules.maxWalletBps = num(mw, "pct_bps");
    if (rules.maxWalletBps < bnd.minMaxWalletBps || rules.maxWalletBps > bnd.maxMaxWalletBps) problems.push(`Max wallet must be ${pct(bnd.minMaxWalletBps)} to ${pct(bnd.maxMaxWalletBps)}.`);
  }
  const cl = by.get("creator_lock");
  if (cl) {
    rules.creatorLockSecs = num(cl, "days_secs");
    if (rules.creatorLockSecs > bnd.maxCreatorLockSecs) problems.push(`The creator lock lasts at most ${days(bnd.maxCreatorLockSecs)}.`);
  }
  const el = by.get("early_lock");
  if (el) {
    rules.earlyWindowSecs = num(el, "window_secs");
    rules.earlyLockSecs = num(el, "lock_secs");
    if (rules.earlyWindowSecs > bnd.maxEarlyWindowSecs) problems.push(`The early-buyer window is at most ${bnd.maxEarlyWindowSecs} seconds.`);
    if (rules.earlyLockSecs > bnd.maxEarlyLockSecs) problems.push(`The early-buyer lock lasts at most ${days(bnd.maxEarlyLockSecs)}.`);
    if (rules.earlyLockSecs <= rules.earlyWindowSecs) problems.push("The early-buyer lock has to end after the buy window does.");
  }
  const kitOn = rules.holderFeeBuyBps + rules.holderFeeSellBps > 0 || rules.maxWalletBps > 0 || rules.creatorLockSecs > 0 || rules.earlyWindowSecs > 0;
  const ex = by.get("exit_halflife");
  if (ex) {
    const start = num(ex, "start_bps"), half = num(ex, "half_secs"), zero = num(ex, "zero_secs");
    if (start !== HALF_LIFE_CURVE.startBps || half !== HALF_LIFE_CURVE.halfSecs || zero !== HALF_LIFE_CURVE.zeroSecs)
      problems.push(`The paper hands fee runs on Half-Life, whose curve is fixed: 20% at first, halving every 6 hours, free after 48 hours. Hook Lab has ${pct(start)}, halving every ${hours(half)}, free after ${hours(zero)}.`);
  }
  const games = ["lottery", "jackpot", "streak", "strategy"].filter(has);
  if (games.length > 1) problems.push(`A coin runs one game; this config has ${games.length}.`);
  const lot = by.get("lottery");
  let game = null;
  if (lot) {
    const potBps = num(lot, "fill_bps"), roundSecs = num(lot, "round_secs");
    if (!(potBps > 0 && potBps <= 1e4)) problems.push("The lottery pot needs a share of the creator fee between 0.01% and 100%.");
    if (roundSecs < 3600 || roundSecs > 30 * 86400) problems.push("A lottery round lasts an hour to 30 days.");
    if (creatorFeeBps === 0) problems.push("The lottery is paid from the creator fee, which is 0%. Add a creator fee.");
    game = { kind: "lottery", potBps, roundSecs };
  }
  const hooks = [kitOn && "the kit rules (holder rewards, max wallet, creator lock, early-buyer lock)", ex && "the paper hands fee", games.length && "a game"].filter(Boolean);
  if (hooks.length > 1) problems.push(`A coin can run one token hook. This config uses ${hooks.join(" and ")}. Keep one; burn and the creator fee work with any of them.`);
  const mode = game ? "lottery" : ex ? "halfLife" : kitOn ? "kit" : "none";
  const fs = by.get("fee_split");
  const dv = by.get("dev_vest");
  let companion = null;
  if (fs || dv || game) {
    const pot = game ? game.potBps : 0;
    const rest = 1e4 - pot;
    const bbShare = fs ? num(fs, "bb_bps") : 0, hShare = fs ? num(fs, "h_bps") : 0;
    if (bbShare + hShare > 1e4) problems.push("The fee split\u2019s buyback and holders add up to more than 100%.");
    const buybackBps = Math.round(rest * bbShare / 1e4);
    const holdersBps = Math.round(rest * hShare / 1e4);
    const beneficiaryBps = Math.max(0, rest - buybackBps - holdersBps);
    if (holdersBps > 0 && !(rules.holderFeeBuyBps + rules.holderFeeSellBps > 0)) problems.push("The fee split pays holders, which goes through holder rewards. Add the Holder rewards block, or set the holders\u2019 share to 0.");
    if (holdersBps > 0 && game) problems.push("A game coin runs its own token hook, so it has no holder rewards: set the fee split\u2019s holders share to 0.");
    if ((fs || game) && creatorFeeBps === 0) problems.push("The fee split and games are paid from the creator fee, which is 0%.");
    const vestSecs = dv ? num(dv, "days_secs") : 0;
    const devBuyBps = dv ? num(dv, "buy_bps") : 0;
    if (vestSecs > 365 * 86400) problems.push("The dev bag vests over at most a year.");
    if (dv && rules.maxWalletBps > 0 && devBuyBps > rules.maxWalletBps) problems.push(`The dev buys ${pct(devBuyBps)}, more than the ${pct(rules.maxWalletBps)} max wallet lets one wallet hold.`);
    if (rules.creatorLockSecs > 0) problems.push("With a companion (fee split, dev bag or a game), the dev bag vests instead of the creator lock. Remove the Creator lock block, or use Dev bag vesting.");
    if (ex) problems.push("A companion (fee split, dev bag or a game) can\u2019t run with the paper hands fee: a companion runs no custom token hook except its own game\u2019s.");
    companion = { split: { buybackBps, holdersBps, beneficiaryBps }, vestSecs, devBuyBps };
  }
  const sn = by.get("sniper_fee");
  if (sn && (num(sn, "start_bps") !== limits.sniper.startBps || num(sn, "secs_secs") !== limits.sniper.windowSecs))
    notes.push(`The sniper fee is set for the whole launchpad: ${pct(limits.sniper.startBps)} for the first ${limits.sniper.windowSecs} seconds, not the ${pct(num(sn, "start_bps"))} for ${num(sn, "secs_secs")} seconds in Hook Lab.`);
  if (!sn) notes.push(`Every coin on this launchpad has the sniper fee: ${pct(limits.sniper.startBps)} pool fee for the first ${limits.sniper.windowSecs} seconds.`);
  if (game) notes.push("The lottery draws need a keeper that sends draw, reveal and claim when a round ends, and the ORAO VRF oracle (on devnet and mainnet, not on a local test chain). Until a keeper runs, the pot just grows.");
  if (game || mode === "halfLife") notes.push("Pots in hooks that are not marked audited are capped at 10 SOL.");
  if (mode === "halfLife" || mode === "lottery") steps.push(`Create a launch config naming the ${mode === "halfLife" ? "Half-Life" : "lottery"} hook, with a ${pct(creatorFeeBps)} creator fee${rules.burnBuyBps + rules.burnSellBps ? " and the burn" : ""}.`);
  if (companion) steps.push(`Create the companion: every creator-fee claim goes ${[game && `${pct(game.potBps)} to the pot`, companion.split.buybackBps && `${pct(companion.split.buybackBps)} to buy back and burn`, companion.split.holdersBps && `${pct(companion.split.holdersBps)} to holders`, companion.split.beneficiaryBps && `${pct(companion.split.beneficiaryBps)} to you`].filter(Boolean).join(", ")}${companion.vestSecs ? `; your dev bag vests over ${days(companion.vestSecs)}` : ""}.`);
  if (mode === "halfLife") steps.push("Prepare Half-Life for the new mint.");
  if (game) steps.push(`Prepare the lottery hook and the game: a draw every ${hours(game.roundSecs)}.`);
  steps.push(`Launch ${name || "the coin"} ($${symbol || "?"})${companion ? " through the companion" : ""}: ${[creatorFeeBps && `${pct(creatorFeeBps)} creator fee`, rules.holderFeeBuyBps + rules.holderFeeSellBps && `holder rewards ${pct(rules.holderFeeBuyBps)}/${pct(rules.holderFeeSellBps)}`, rules.burnBuyBps + rules.burnSellBps && `burn ${pct(rules.burnBuyBps)}/${pct(rules.burnSellBps)}`, rules.maxWalletBps && `max wallet ${pct(rules.maxWalletBps)}`, rules.creatorLockSecs && `creator lock ${days(rules.creatorLockSecs)}`, rules.earlyWindowSecs && `early buyers locked ${hours(rules.earlyLockSecs)}`].filter(Boolean).join(", ") || "pool fee only"}.`);
  if (mode === "halfLife") steps.push("Light the furnace, so paper hands fees can be burned.");
  if (companion?.devBuyBps) steps.push(`Dev buy of about ${pct(companion.devBuyBps)} of supply, held by the companion and vesting to you.`);
  return {
    name,
    symbol,
    creatorFeeBps,
    rules,
    mode,
    companion,
    game,
    steps,
    problems,
    notes,
    executionProblems: game ? ["UNSUPPORTED beta execution: Lottery launch is experimental and disabled in beta: no keeper is provided. Planning remains available."] : [],
    blocks: blocks.map((b) => ({ type: b.type, status: Object.hasOwn(FIELDS, b.type) ? "wired" : "unsupported" }))
  };
}

// sdk/packages/launcher/src/integration.ts
var integrationCapabilities = {
  schemaVersion: "hooklab-capabilities/1",
  cluster: "devnet",
  recipes: {
    plain: "preview-and-inspect",
    kit: "preview-and-inspect",
    halfLife: "preview-and-inspect",
    lottery: "deferred",
    custom: "deferred",
    companion: "deferred"
  },
  trading: "deferred-hook-aware-quotes",
  unsignedMessages: false,
  signing: false,
  sending: false
};
function previewHookLabIntegration(raw, inspection) {
  const plan = planFromHookLab(raw, inspection?.limits ?? void 0);
  const refusals = plan.problems.map((message) => ({ code: "INVALID_RECIPE", subject: "recipe", message }));
  refusals.push(...inspection?.refusals ?? []);
  if (plan.companion) refusals.push({ code: "COMPANION_DEFERRED", subject: "recipe", message: "Companion funding, dev buys, games and recovery are not supported by the integration API." });
  if (plan.game) refusals.push({ code: "LOTTERY_DEFERRED", subject: "recipe", message: "No approved keeper/oracle operations or lottery launch flow." });
  if (inspection && (!inspection.limits || inspection.sourceCommit !== integrationManifest().sourceCommit || inspection.schemaVersion !== "hooklab-inspection/1"))
    refusals.push({ code: "INSPECTION_INCOMPATIBLE", subject: "inspection", message: "Inspection lacks matching schema, ABI baseline or live launch limits." });
  const recipe = plan.game ? "lottery" : plan.companion ? "companion" : plan.mode === "none" ? "plain" : plan.mode;
  return {
    schemaVersion: "hooklab-plan/1",
    kind: "intent-only",
    cluster: "devnet",
    sourceCommit: integrationManifest().sourceCommit,
    recipe,
    name: plan.name,
    symbol: plan.symbol,
    creatorFeeBps: plan.creatorFeeBps,
    rules: plan.rules,
    steps: plan.steps.map((description, index) => ({ index, description, messageBase64: null })),
    observedSlot: inspection?.observedSlot ?? null,
    economics: inspection?.accounts ?? null,
    exactWalletDebitLamports: null,
    networkFeeLamports: null,
    rentLamports: null,
    minOutputRaw: null,
    expiry: null,
    signers: { wallet: "client-wallet-required", mint: "client-generated-and-retained", serverSigner: false },
    prerequisites: [
      "Validate manifest/IDL versions and inspect the same devnet RPC.",
      "Review observed economics, authority recipients and protocol-wide sniper fee.",
      "Client must retain the new mint signer before requesting any message; never transmit its secret.",
      "No integration transaction is enabled until exact debits, rent, expiry and recovery are implemented."
    ],
    recovery: "Steps may be non-atomic. Preserve mint/config identities and signatures; inspect finality before retrying. No automatic rollback or resume.",
    warnings: [
      ...plan.notes,
      ...inspection?.warnings ?? [],
      ...inspection ? [] : ["OFFLINE_DEFAULTS: limits and sniper fee are setup defaults, not a live inspection."],
      "INTENT_ONLY: no transaction bytes, wallet authorization, simulation or execution readiness."
    ],
    refusals
  };
}

// repoing-readonly-entry.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { createHash as createHash3 } from "node:crypto";
function integrationManifest2() {
  const bytes = readFileSync2(new URL("../integration/devnet.json", import.meta.url));
  if (createHash3("sha256").update(bytes).digest("hex") !== "3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403") throw new Error("Hook Lab manifest checksum mismatch.");
  return integrationManifest();
}
export {
  inspectDevnetIntegration,
  integrationCapabilities,
  integrationCompatibility,
  integrationIdlRefusals,
  integrationManifest2 as integrationManifest,
  previewHookLabIntegration
};
