import Layer from '../../Layer'
import Tensor from '../../Tensor'
import * as activations from '../../activations'
import { webgl2 } from '../../WebGL2'
import { gemv } from 'ndarray-blas-level2'
import ops from 'ndarray-ops'

/**
 * Dense layer class
 */
export default class Dense extends Layer {
  /**
   * Creates a Dense layer
   * @param {Number} attrs.units - output dimension size
   * @param {Object} [attrs] - layer attributes
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'Dense'

    const { units = 1, activation = 'linear', input_dim = null, use_bias = true } = attrs

    this.activation = activation
    this.activationFunc = activations[this.activation]
    this.units = units
    this.input_dim = input_dim
    this.use_bias = use_bias

    // Layer weights specification
    this.params = this.use_bias ? ['kernel', 'bias'] : ['kernel']

    // Input shape specification
    if (this.input_dim) {
      this.inputShape = [this.input_dim]
    }

    // Output
    this.output_preactiv = new Tensor([], [this.units])
    this.output = new Tensor([], [this.units])

    // GPU setup
    if (this.gpu) {
      this.matMulProgram = webgl2.compileProgram(require('../../matMul.webgl2.glsl'))
      this.activationProgram = webgl2.compileProgram(require(`../../activations/${this.activation}.webgl2.glsl`))
      this.output_preactiv.createGLTexture()
      this.output.createGLTexture()
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._call_gpu(x)
    } else {
      this._call_cpu(x)
    }
    return this.output
  }

  /**
   * CPU call
   */
  _call_cpu(x) {
    if (this.use_bias) {
      ops.assign(this.output.tensor, this.weights['bias'].tensor)
    }
    gemv(1, this.weights['kernel'].tensor.transpose(1, 0), x.tensor, 1, this.output.tensor)
    this.activationFunc(this.output)
  }

  /**
   * GPU call
   */
  _call_gpu(x) {
    if (!x.glTexture) {
      x.createGLTexture()
    }

    // Matrix Multiply
    webgl2.selectProgram(this.matMulProgram)
    webgl2.bindOutputTexture(this.output_preactiv.glTexture, this.output_preactiv.glTextureShape)
    let textures = [x.glTexture, this.weights['kernel'].glTexture]
    let textureTypes = ['2d', '2d']
    let textureNames = ['A', 'B']
    if (this.use_bias) {
      textures.push(this.weights['bias'].glTexture)
      textureTypes.push('2d')
      textureNames.push('C')
    }
    webgl2.bindInputTextures(this.matMulProgram, textures, textureTypes, textureNames)
    const uniforms = [this.use_bias ? 1 : 0, x.glTextureShape[0], ...this.weights['kernel'].glTextureShape]
    const uniformTypes = ['bool', 'int', 'int', 'int']
    const uniformNames = ['addC', 'M', 'K', 'N']
    webgl2.bindUniforms(this.matMulProgram, uniforms, uniformTypes, uniformNames)
    webgl2.runProgram()

    // Activation
    webgl2.selectProgram(this.activationProgram)
    webgl2.bindOutputTexture(this.output.glTexture, this.output.glTextureShape)
    textures = [this.output_preactiv.glTexture]
    textureTypes = ['2d']
    textureNames = ['x']
    webgl2.bindInputTextures(this.activationProgram, textures, textureTypes, textureNames)
    webgl2.runProgram()

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
    }
  }
}
