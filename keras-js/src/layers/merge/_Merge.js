import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import isEqual from 'lodash/isEqual'
import range from 'lodash/range'

/**
 * _Merge layer class
 */
export default class _Merge extends Layer {
  /**
   * Creates a _Merge layer
   * @param {Object} [attrs] - layer attributes
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = '_Merge'

    // GPU setup
    if (this.gpu) {
      this.copyTextureProgram = webgl2.compileProgram(require('../../copyTexture.webgl2.glsl'))
    }
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor[]} inputs
   * @returns
   */
  call(inputs) {
    if (this.gpu) {
      inputs.forEach(input => {
        if (!input.glTexture) {
          input.createGLTexture()
        }
      })
      this._call_gpu(inputs)
    } else {
      const valid = this._validateInputs(inputs)
      if (!valid) {
        throw new Error(`${this.name} [${this.layerClass} layer] Invalid inputs to call method.`)
      }
      this._call_cpu(inputs)
    }
    return this.output
  }

  /**
   * Internal method for validating inputs
   * @param {Tensor[]} inputs
   * @returns {Boolean} valid
   */
  _validateInputs(inputs) {
    const shapes = inputs.map(x => x.tensor.shape.slice())
    if (['sum', 'mul', 'ave', 'max'].indexOf(this.mode) > -1) {
      if (!shapes.every(shape => isEqual(shape, shapes[0]))) {
        throw new Error(
          `${this.name} [${this.layerClass} layer] All input shapes must be the same for mode ${this.mode}.`
        )
      }
    }
    if (this.mode === 'dot') {
      if (inputs.length !== 2) {
        throw new Error(`${this.name} [${this.layerClass} layer] Exactly 2 inputs required for mode ${this.mode}.`)
      }
      if (this.dotAxes[0] < 0) {
        this.dotAxes[0] = shapes[0].length + this.dotAxes[0]
      }
      if (this.dotAxes[1] < 0) {
        this.dotAxes[1] = shapes[1].length + this.dotAxes[1]
      }
      if (shapes[0][this.dotAxes[0]] !== shapes[1][this.dotAxes[1]]) {
        throw new Error(`${this.name} [${this.layerClass} layer] Dimensions incompatibility using dot mode.`)
      }
    } else if (this.mode === 'concat') {
      let nonConcatShapes = shapes.slice()
      let _concatAxis = this.concatAxis < 0 ? nonConcatShapes[0].length + this.concatAxis : this.concatAxis
      if (this.concatAxis === 0) _concatAxis = 0
      range(nonConcatShapes.length).forEach(i => {
        nonConcatShapes[i].splice(_concatAxis, 1)
      })
      if (!nonConcatShapes.every(shape => isEqual(shape, nonConcatShapes[0]))) {
        throw new Error(
          `${this.name} [${this
            .layerClass} layer] In concat mode, all shapes must be the same except along the concat axis.`
        )
      }
    }
    return true
  }

  /**
   * CPU call
   * @param {Tensor[]} inputs
   */
  _call_cpu(inputs) {
    // implemented in child classes
  }

  /**
   * GPU call
   * mode: sum, mul, ave, max
   * method for mode concat/dot implemented in child class
   * @param {Tensor[]} inputs
   */
  _call_gpu(inputs) {
    // create output textures if doesn't already exist
    if (!this.output) {
      this.output = new Tensor([], inputs[0].glTextureShape)
      this.output.createGLTexture()
      if (inputs[0].glTextureIsTiled) {
        this.output.glTextureIsTiled = inputs[0].glTextureIsTiled
        this.output.untiledShape = inputs[0].untiledShape
      }
    }

    const numInputs = inputs.length

    webgl2.selectProgram(this.mergeProgram)
    webgl2.bindOutputTexture(this.output.glTexture, this.output.glTextureShape)
    const uniforms = [...this.output.glTextureShape]
    const uniformTypes = ['int', 'int']
    const uniformNames = ['rows', 'cols']
    if (this.mode === 'ave') {
      uniforms.push(numInputs)
      uniformTypes.push('int')
      uniformNames.push('numInputs')
    }
    webgl2.bindUniforms(this.mergeProgram, uniforms, uniformTypes, uniformNames)

    const textures = [inputs[0].glTexture, inputs[1].glTexture]
    const textureTypes = ['2d', '2d']
    const textureNames = ['input1', 'input2']
    webgl2.bindInputTextures(this.mergeProgram, textures, textureTypes, textureNames)
    webgl2.runProgram()

    if (numInputs > 2) {
      if (!this.runningOutput) {
        this.runningOutput = new Tensor([], inputs[0].glTextureShape)
        this.runningOutput.createGLTexture()
      }

      for (let i = 2; i < numInputs; i++) {
        // copy output texture to intermediate output
        webgl2.selectProgram(this.copyTextureProgram)
        webgl2.bindOutputTexture(this.runningOutput.glTexture, this.runningOutput.glTextureShape)
        webgl2.bindInputTextures(this.copyTextureProgram, [this.output.glTexture], ['2d'], ['source'])
        webgl2.runProgram()

        webgl2.bindUniforms(this.mergeProgram, [i], ['int'], ['i'])
        const textures = [this.runningOutput.glTexture, inputs[i].glTexture]
        webgl2.bindInputTextures(this.mergeProgram, textures, textureTypes, textureNames)
        webgl2.runProgram()
      }
    }

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
    }
  }
}
