'use strict';

var ref = require('ref');
var StructType = require('ref-struct');
var ArrayType = require('ref-array');
var ffi = require('ffi');
var weak = require('weak');

module.exports = function (vips) {
    // inherit from GObject fields
    var LayoutImage = Object.assign(Object.assign({}, 
        vips.LayoutObject), {
        // opaque
    });
    var StructImage = StructType(LayoutImage);
    var StructImageP = ref.refType(StructImage);
    var ArrayDouble = ArrayType('double');
    var ArrayString = ArrayType('string');
    var SizeP = ref.refType('size_t');
    var DoubleP = ref.refType('double');

    var libglib = ffi.Library('libglib-2.0', {
        g_free: ['void', ['pointer']],
        g_strfreev: ['void', ['pointer']]
    });

    var libvips = ffi.Library('libvips', {
        vips_foreign_find_load: ['string', ['string']],
        vips_foreign_find_load_buffer: ['string', ['pointer', 'size_t']],
        vips_foreign_find_save: ['string', ['string']],
        vips_foreign_find_save_buffer: ['string', ['string']],

        vips_image_new_matrix_from_array: [StructImageP, 
            [ref.types.int, ref.types.int, ArrayDouble, ref.types.int]],
        vips_image_new_from_memory: [StructImageP, 
            ['pointer', ref.types.size_t, 
             ref.types.int, ref.types.int, ref.types.int, ref.types.int]],
        vips_image_copy_memory: [StructImageP, [StructImageP]],

        vips_image_get_typeof: [vips.GType, [StructImageP, 'string']],
        vips_image_get: [vips.GType, 
            [StructImageP, 'string', vips.StructGValueP]],
        vips_image_set: [vips.GType, 
            [StructImageP, 'string', vips.StructGValueP]],
        vips_image_remove: [ref.types.int, [StructImageP, 'string']],
        vips_image_get_fields: [ArrayString, [StructImageP]],

        vips_filename_get_filename: ['string', ['string']],
        vips_filename_get_options: ['string', ['string']],

        vips_image_new_temp_file: [StructImageP, ['string']],

        vips_image_write: [ref.types.int, [StructImageP, 'string']],
        vips_image_write_to_memory: ['pointer', [StructImageP, SizeP]],

    });

    // either a single number, or a table of numbers
    function is_pixel(x) {
        return typeof x == 'number' || Array.isArray(x); 
    }

    // test for rectangular array of something
    function is_2D(x) {
        if (!Array.isArray(x)) {
                return false;
        }

        for (let i in x) {
            if (!Array.isArray(x[i]) ||
                    x[i].length != x[0].length) {
                    return false;
            }
        }

        return true;
    }

    // apply a function to a thing, or map over a list
    // we often need to do something like (1.0 / other) and need to work for 
    // lists as well as scalars
    function smap(x, fn) {
        if (Array.isArray(x)) {
            return x.map(fn);
        }
        else {
            return fn(x);
        }
    }

    function call_enum(image, other, base, operation) {
        if (is_pixel(other)) {
            return vips.call(base + '_const', image, operation, other);
        }
        else {
            return vips.call(base, image, other, operation);
        }
    }

     function run_cmplx(image, fn) {
        // Run a complex function on a non-complex image.
        //
        // The image needs to be complex, or have an even number of bands. 
        // The input can be int, the output is always float or double.

        var original_format = image.format; 

        if (image.format != 'complex' && image.format != 'dpcomplex') { 
            if (image.bands % 2 != 0) { 
                throw new Error('not an even number of bands');
            }

            if (image.format != 'float' && image.format != 'double') { 
                image = image.cast('float');
            }

            var new_format = 
                (image.format == 'double') ? 'dpcomplex' : 'complex';  

            image = image.copy({format: new_format, bands: image.bands / 2});
        }

        image = fn(image);

        if (original_format != 'complex' && original_format != 'dpcomplex') {
            var new_format = 
                (image.format == 'dpcomplex') ? 'double' : 'float';  

            image = image.copy({format: new_format, bands: image.bands * 2});
        }

        return image;
     }

    var Image = function (ptr) {
        vips.VipsObject.call(this, ptr);

        // this is horrible! but I don't see how to add these to the prototype:
        // we lose "this" for proto properties
        [
            'width',
            'height',
            'bands',
            'format',
            'interpretation',
            'xres',
            'yres',
            'xoffset',
            'yoffset',
            'filename'
        ].forEach((name) => {
            Object.defineProperty(this, name, {
                get: () => {
                    return this.get(name);
                }
            });
        });

        // scale and offset have default values
        [
            ['scale', 1.0], 
            ['offset', 0.0] 
        ].forEach((x) => {
            var name = x[0];
            var default_value = x[1];

            Object.defineProperty(this, name, {
                get: () => {
                    if (this.get_typeof(name) == 0) {
                        return default_value;
                    }
                    else {
                        return this.get(name);
                    }
                }
            });
        });
    }

    Image.prototype = Object.create(vips.VipsObject.prototype);
    Image.prototype.constructor = Image;

    Image.imageize = function (match_image, value) {
        // careful! match_image can be None if value is a 2D array
        if (value instanceof Image) {
            return value;
        }
        else if (is_2D(value)) { 
            return Image.new_from_array(value);
        }
        else {
            return match_image.new_from_image(value);
        }
    }

    // constructors

    Image.new_from_file = function (vips_filename, options) {
        options = typeof options !== 'undefined' ? options : {};
        options = Object.assign({}, options)

        var filename = libvips.vips_filename_get_filename(vips_filename);
        var string_options = libvips.vips_filename_get_options(vips_filename);
        var name = libvips.vips_foreign_find_load(filename);
        if (name == ref.NULL) {
            throw new vips.VipsError('unable to load from file ' + 
                vips_filename);
        }
        options.string_options = string_options;

        return vips.call(name, filename, options);
    }

    Image.new_from_array = function (array, scale, offset) {
        scale = typeof scale !== 'undefined' ? scale : 1.0;
        offset = typeof offset !== 'undefined' ? offset : 0.0;

        if (!is_2D(array)) {
            array = [array];
        }

        var height = array.length;
        var width = array[0].length;
        var n = width * height;
        var a = new ArrayDouble(n);

        for (var y = 0; y < height; y++) {
            for (var x = 0; x < width; x++) {
                a[x + y * width] = array[y][x]
            }
        }

        var vi = libvips.vips_image_new_matrix_from_array(width, height, a, n);
        if (vi == ref.NULL) {
            throw new vips.VipsError('unable to make image from matrix')
        }
        var image = new Image(vi);

        image.set_typeof(vips.GTYPES.gdouble, 'scale', scale);
        image.set_typeof(vips.GTYPES.gdouble, 'offset', offset);

        return image;
    }

    Image.new_from_buffer = function (data, string_options, options) {
        string_options = 
            typeof string_options !== 'undefined' ? string_options : "";
        options = typeof options !== 'undefined' ? options : {};

        var name = libvips.vips_foreign_find_load_buffer(data, data.length);
        if (name == ref.NULL) {
            throw new vips.VipsError('unable to load from buffer');
        }

        var image = vips.call(name, data, options);

        // keep a secret ref to the underlying memory area
        image._data = data;

        return image;
    }

    Image.new_from_memory = function (data, width, height, bands, format) {
        var format_value = vips.to_enum(vips.GTYPES.VipsBandFormat, format);

        var vi = libvips.vips_image_new_from_memory(data, data.length,
            width, height, bands, format_value);
        if (vi == ref.NULL) {
            throw new vips.VipsError('unable to make image from memory');
        }

        var image = new Image(vi);

        // keep a secret ref to the underlying memory area
        image._data = data;

        return image;
    }

    Image.prototype.new_from_image = function (value) {
        var pixel = Image.black(1, 1).add(value).cast(this.format);
        var image = pixel.embed(0, 0, this.width, this.height,
            {extend: 'copy'});
        image = image.copy({
            interpretation: this.interpretation,
            xres: this.xres,
            yres: this.yres,
            xoffset: this.xoffset,
            yoffset: this.yoffset
        });

        return image
    }

    Image.prototype.copy_memory = function () {
        var vi = libvips.vips_image_copy_memory(this.buffer);
        if (vi == ref.NULL) {
            throw new vips.VipsError('unable to copy image to memory');
        }

        return new Image(vi);
    }

    // writers

    Image.prototype.write_to_file = function (vips_filename, options) {
        options = typeof options !== 'undefined' ? options : {};
        options = Object.assign({}, options)

        var filename = libvips.vips_filename_get_filename(vips_filename);
        var string_options = libvips.vips_filename_get_options(vips_filename);
        var name = libvips.vips_foreign_find_save(filename);
        if (name == ref.NULL) {
            throw new vips.VipsError('unable to write to file ' + vips_filename);
        }
        options.string_options = string_options;

        return vips.call(name, this, filename, options);
    }

    Image.prototype.write_to_buffer = function (format_string, options) {
        options = typeof options !== 'undefined' ? options : {};
        options = Object.assign({}, options)

        var string_options = libvips.vips_filename_get_options(format_string);
        var name = libvips.vips_foreign_find_save_buffer(format_string);
        if (name == ref.NULL) { 
            throw new vips.VipsError('unable to write to buffer');
        }
        options.string_options = string_options;

        return vips.call(name, this, options);
    }

    Image.prototype.write_to_memory = function () {
        var size = ref.alloc('size_t')
        var ptr = libvips.vips_image_write_to_memory(this.buffer, size);
        var result = ref.reinterpret(ptr, size.deref());

        // we keep the finalize closure in the Buffer, with a weakref from
        // itself 
        result.finalize = function () {
            console.log("Image.write_to_memory.finalize: free 0x" + 
                  result.ref().address().toString(16));
            libglib.g_free(result.ref());
        }
        weak(result, result.finalize); 

        return result;
    }

    // get/set metadata

    Image.prototype.get_typeof = function (field) {
        // before libvips 8.5, property types must be fetched separately,
        // since built-in enums were reported as ints
        if (!vips.at_least_libvips(8, 5)) {
            var gtype = vips.VipsObject.prototype.get_typeof.call(this, field);
            if (gtype != 0) {
                return gtype;
            }
        }

        return libvips.vips_image_get_typeof(this.buffer, field);
    }

    Image.prototype.get = function (field) {
        if (!vips.at_least_libvips(8, 5)) {
            var gtype = vips.VipsObject.prototype.get_typeof.call(this, field);
            if (gtype != 0) {
                return vips.VipsObject.prototype.get.call(this, field);
            }
        }

        var gv = new vips.GValue();
        var result = libvips.vips_image_get(this.buffer, field, gv.buffer.ref());
        if (result != 0) { 
            throw new vips.VipsError('unable to get ' + field);
        }

        return gv.get();
    }

    Image.prototype.get_fields = function () {
        var ptr = libvips.vips_image_get_fields(this.buffer);

        // it's terminated by a NULL pointer .. search for the end
        var array = ArrayString.untilZeros(ptr.buffer);

        var names = [];
        for (var i = 0; i < array.length; i++) {
            // will this copy the string, or share a pointer? no idea
            names.push(array[i]);
        }
        libglib.g_strfreev(ptr.buffer);

        return names;
    }

    Image.prototype.set_typeof = function (gtype, field, value) {
        var gv = new vips.GValue();
        gv.init(gtype);
        gv.set(value);
        libvips.vips_image_set(this.buffer, field, gv.buffer.ref());
    }

    Image.prototype.set = function (field, value) {
        this.set_typeof(this.get_typeof(field), field, value);
    }

    Image.prototype.remove = function (field) {
        libvips.vips_image_remove(this.buffer, field);
    }

    // hand-written wrappers

    Image.prototype.add = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('add', this, value, options);
        }
        else {
            return vips.call('linear', this, 1, value, options);
        }
    }

    Image.prototype.subtract = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('subtract', this, value, options);
        }
        else {
            return vips.call('linear', this, 1, smap(value, (x) => {
                    return -1 * x;
                }, options));
        }
    }

    Image.prototype.rsubtract = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('linear', this, -1, 0, options).add(value);
        }
        else {
            return vips.call('linear', this, -1, value, options);
        }
    }

    Image.prototype.multiply = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('multiply', this, value, options);
        }
        else {
            return vips.call('linear', this, value, 0, options);
        }
    }

    Image.prototype.divide = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('divide', this, value, options);
        }
        else {
            return vips.call('linear', this, smap(value, (x) => {
                    return Math.pow(x, -1);
                }), 0, options);
        }
    }

    Image.prototype.rdivide = function (value, options) {
        return this.pow(-1).multiply(value);
    }

    Image.prototype.remainder = function (value, options) {
        options = typeof options !== 'undefined' ? options : {};

        if (value instanceof Image) {
            return vips.call('remainder', this, value, options);
        }
        else {
            return vips.call('remainder_const', this, value, options);
        }
    }

    Image.prototype.ifthenelse = function (th, el, options) {
        var match_image;
        for (let x of [th, el, this]) {
            if (x instanceof Image) {
                match_image = x;
                break;
            }
        }

        if (!(th instanceof Image)) {
            th = Image.imageize(match_image, th);
        }
        if (!(el instanceof Image)) {
            el = Image.imageize(match_image, el);
        }


        return vips.call('ifthenelse', this, th, el, options);
    }

    // renamed operators

    // "scale" operator renamed to avoid a clash with the "scale" attribute
    Image.prototype.scaleimage = function (options) {
        return vips.call('scale', this, options);
    }

    // "crop" as a synonym for extract_area
    Image.prototype.crop = function (left, top, width, height, options) {
        return vips.call('extract_area', this, 
            left, top, width, height, options);
    }

    // "band" as a synonym for extract_band
    Image.prototype.band = function (left, top, width, height, options) {
        return vips.call('extract_band', this, band, options);
    }

    // convenience methods

    Image.prototype.bandsplit = function (options) {
        var result = [];
        for (var i = 0; i < this.bands; i++) {
            result.push(this.extract_band(i, options));
        }

        return result;
    }

    // Append a set of images or constants bandwise.
    Image.prototype.bandjoin = function (other, options) {
        if (!Array.isArray(other)) {
            other = [other];
        }

        // if [other] is all numbers, we can use bandjoin_const
        if (other.every((x) => {return typeof x == 'number';})) { 
            return this.bandjoin_const(other, options);
        }
        else {
            other.unshift(this)
            return vips.call('bandjoin', other, options);
        }
    }

    // return [max_x, max_y, max_value]
    Image.prototype.maxpos = function (options) {
        options = Object.assign({}, options)
        options.x = true;
        options.y = true;

        var result = this.max(options);

        return [result[1]['x'], result[1]['y'], result[0]];
    }

    // return [min_x, min_y, min_value]
    Image.prototype.minpos = function (options) {
        options = Object.assign({}, options)
        options.x = true;
        options.y = true;

        var result = this.min(options);

        return [result[1]['x'], result[1]['y'], result[0]];
    }

    // enum expansions

    Image.prototype.pow = function (value, options) {
        return call_enum(this, value, 'math2', 'pow');
    }

    Image.prototype.wop = function (value, options) {
        return call_enum(this, value, 'math2', 'wop');
    }

    Image.prototype.lshift = function (value, options) {
        return call_enum(this, value, 'boolean', 'lshift');
    }

    Image.prototype.rshift = function (value, options) {
        return call_enum(this, value, 'boolean', 'rshift');
    }

    Image.prototype.and = function (value, options) {
        return call_enum(this, value, 'boolean', 'and');
    }

    Image.prototype.or = function (value, options) {
        return call_enum(this, value, 'boolean', 'or');
    }

    Image.prototype.eor = function (value, options) {
        return call_enum(this, value, 'boolean', 'eor');
    }

    Image.prototype.more = function (value, options) {
        return call_enum(this, value, 'relational', 'more');
    }

    Image.prototype.moreeq = function (value, options) {
        return call_enum(this, value, 'relational', 'moreeq');
    }

    Image.prototype.less = function (value, options) {
        return call_enum(this, value, 'relational', 'less');
    }

    Image.prototype.lesseq = function (value, options) {
        return call_enum(this, value, 'relational', 'lesseq');
    }

    Image.prototype.equal = function (value, options) {
        return call_enum(this, value, 'relational', 'equal');
    }

    Image.prototype.noteq = function (value, options) {
        return call_enum(this, value, 'relational', 'noteq');
    }

    Image.prototype.floor = function (value, options) {
        return call_enum(this, value, 'round', 'floor');
    }

    Image.prototype.ceil = function (value, options) {
        return call_enum(this, value, 'round', 'ceil');
    }

    Image.prototype.rint = function (value, options) {
        return call_enum(this, value, 'round', 'rint');
    }

    Image.prototype.bandand = function (value, options) {
        return call_enum(this, value, 'bandbool', 'and');
    }

    Image.prototype.bandor = function (value, options) {
        return call_enum(this, value, 'bandbool', 'or');
    }

    Image.prototype.bandeor = function (value, options) {
        return call_enum(this, value, 'bandbool', 'eor');
    }

    Image.prototype.real = function (value, options) {
        return this.complexget('real', options);
    }

    Image.prototype.imag = function (value, options) {
        return this.complexget('imag', options);
    }

    Image.prototype.polar = function (options) {
        return run_cmplx(this, (x) => {
            return x.complex('polar', options);
        });
    }

    Image.prototype.rect = function (options) {
        return run_cmplx(this, (x) => {
            return x.complex('rect', options);
        });
    }

    Image.prototype.conj = function (options) {
        return this.complex('conj', options);
    }

    Image.prototype.sin = function (options) {
        return this.math('sin', options);
    }

    Image.prototype.cos = function (options) {
        return this.math('cos', options);
    }

    Image.prototype.tan = function (options) {
        return this.math('tan', options);
    }

    Image.prototype.asin = function (options) {
        return this.math('asin', options);
    }

    Image.prototype.acos = function (options) {
        return this.math('acos', options);
    }

    Image.prototype.atan = function (options) {
        return this.math('atan', options);
    }

    Image.prototype.log = function (options) {
        return this.math('log', options);
    }

    Image.prototype.log10 = function (options) {
        return this.math('log10', options);
    }

    Image.prototype.exp = function (options) {
        return this.math('exp', options);
    }

    Image.prototype.exp10 = function (options) {
        return this.math('exp10', options);
    }

    Image.prototype.erode = function (mask, options) {
        return this.morph(mask, 'erode', options);
    }

    Image.prototype.dilate = function (mask, options) {
        return this.morph(mask, 'dilate', options);
    }

    Image.prototype.median = function (size, options) {
        return this.rank(size, size, (size * size) / 2, options);
    }

    Image.prototype.fliphor = function (options) {
        return this.flip('horizontal', options);
    }

    Image.prototype.flipver = function (options) {
        return this.flip('vertical', options);
    }

    Image.prototype.rot90 = function (options) {
        return this.rot('d90', options);
    }

    Image.prototype.rot180 = function (options) {
        return this.rot('d180', options);
    }

    Image.prototype.rot270 = function (options) {
        return this.rot('d270', options);
    }

    // and export

    vips.Image = Image;
};

