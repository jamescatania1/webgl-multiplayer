import { vec2, vec3 } from "gl-matrix";
import Camera from "./Camera";
import Lighting from "./Lighting";
import Cube from "./Cube";
import type Input from "./Input";
import Model from "./Model";
import { loadShaders, type Shaders } from "./Shaders";
import { loadTextures, textures } from "./Resources";

export interface SceneObject {
	update?(): void;
	draw(gl: WebGL2RenderingContext, scene: Scene, camera: Camera, depthOnly: boolean): void;
}

const MAX_VEL = 1.0;
const ACCEL = 0.01;
const MOUSE_SENSITIVITY = 2.0;
const SSAO_KERNEL_SIZE = 32;

export default class Scene {
	public readonly shaders: Shaders;

	private readonly camera: Camera;
	private readonly lighting: Lighting;
	private readonly ubo: WebGLBuffer;
	private readonly cameraUboBuffer: Float32Array = new Float32Array(20);
	private objects: SceneObject[] = [];
	private texturesLoaded = false;

	private readonly input: vec2 = vec2.create();
	private readonly accel: vec3 = vec3.create();
	private readonly vel: vec3 = vec3.create();
	private readonly accelY: vec3 = vec3.create();

	private readonly drawFBO: WebGLFramebuffer;
	private readonly postFBO: WebGLFramebuffer;
	private readonly depthPrepassFBO: WebGLFramebuffer;
	private readonly depthResolveFBO: WebGLFramebuffer;
	private readonly quadVertexBuffer: WebGLBuffer;
	private depthPrepassTexture: WebGLTexture;
	private readonly ssaoTexture: WebGLTexture;
	private readonly ssaoNoiseTexture: WebGLTexture;
	private readonly ssaoQuadVertexBuffer: WebGLBuffer;
	private readonly ssaoFBO: WebGLFramebuffer;
	private readonly ssaoBlurTexture: WebGLTexture;
	private readonly ssaoKernel: Float32Array;

	monke: Model;

	constructor(gl: WebGL2RenderingContext) {
		this.shaders = loadShaders(gl);
		this.camera = new Camera(gl);
		this.lighting = new Lighting(gl, this.camera, this.shaders);
		loadTextures(gl)
			.then((_) => {
				this.texturesLoaded = true;
			})
			.catch((err) => {
				console.error(err);
			});

		this.camera.position[2] = 5.0;

		this.quadVertexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1.0, 1.0, 0.0, 1.0, -1.0, -1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 0.0]),
			gl.STATIC_DRAW,
		);
		gl.vertexAttribPointer(this.shaders.postFX.attributes.vertex_position, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(this.shaders.postFX.attributes.vertex_position);
		gl.vertexAttribPointer(this.shaders.postFX.attributes.tex_coords, 2, gl.FLOAT, false, 16, 8);
		gl.enableVertexAttribArray(this.shaders.postFX.attributes.tex_coords);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);

		this.ssaoQuadVertexBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.ssaoQuadVertexBuffer);
		gl.bufferData(
			gl.ARRAY_BUFFER,
			new Float32Array([-1.0, 1.0, 0.0, 1.0, -1.0, -1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 0.0]),
			gl.STATIC_DRAW,
		);
		gl.vertexAttribPointer(this.shaders.ssao.attributes.vertex_position, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(this.shaders.ssao.attributes.vertex_position);
		gl.vertexAttribPointer(this.shaders.ssao.attributes.tex_coords, 2, gl.FLOAT, false, 16, 8);
		gl.enableVertexAttribArray(this.shaders.ssao.attributes.tex_coords);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);

		// create ssao kernel
		this.ssaoKernel = new Float32Array(SSAO_KERNEL_SIZE * 3);
		for (let i = 0; i < SSAO_KERNEL_SIZE; i++) {
			const sample = vec3.fromValues(Math.random() * 2.0 - 1.0, Math.random() * 2.0 - 1.0, Math.random());
			vec3.normalize(sample, sample);
			let scale = i / SSAO_KERNEL_SIZE;
			scale = 0.1 + scale * scale * (1.0 - 0.1);
			vec3.scale(sample, sample, scale);
			this.ssaoKernel.set(sample, i * 3);
		}

		let ssaoNoise = new Float32Array(16 * 3);
		for (let i = 0; i < 16; i++) {
			const random = vec3.fromValues(Math.random() * 2.0 - 1.0, Math.random() * 2.0 - 1.0, 0.0);
			ssaoNoise.set(random, i * 3);
		}
		this.ssaoNoiseTexture = gl.createTexture();
		gl.activeTexture(gl.TEXTURE10);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoNoiseTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, 4, 4, 0, gl.RGB, gl.FLOAT, ssaoNoise);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		gl.bindTexture(gl.TEXTURE_2D, null);

		this.drawFBO = gl.createFramebuffer();
		this.postFBO = gl.createFramebuffer();
		this.depthPrepassFBO = gl.createFramebuffer();
		this.depthResolveFBO = gl.createFramebuffer();
		this.depthPrepassTexture = gl.createTexture();
		this.ssaoFBO = gl.createFramebuffer();
		this.ssaoTexture = gl.createTexture();
		this.ssaoBlurTexture = gl.createTexture();
		this.updateFramebuffers(gl);

		this.monke = new Model(gl, "/monke-smooth.bobj", textures.monke, this.shaders.diffuse, this.shaders.depth);
		this.monke.roughness = 0.0;
		this.monke.metallic = 1.0;
		// this.add(this.monke);

		const base = new Model(gl, "/scene.bobj", textures.empty, this.shaders.diffuse, this.shaders.depth);
		base.roughness = 1.0;
		this.add(base);
		// const landscape = new Model(gl, "/landscape.bobj", this.shaders.diffuse);
		// landscape.roughness = 1.0;
		// this.add(landscape);
		// const sphere = new Model(gl, "/sphere.bobj", this.shaders.diffuse);
		// sphere.roughness = 0.05;
		// sphere.metallic = 1.0;
		// this.add(sphere);

		gl.enable(gl.CULL_FACE);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.clearColor(0.0, 0.0, 0.0, 1.0);

		// create global ubo
		this.ubo = gl.createBuffer();
		gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
		gl.bufferData(gl.UNIFORM_BUFFER, 240, gl.DYNAMIC_DRAW);
		gl.bindBufferRange(gl.UNIFORM_BUFFER, 0, this.ubo, 0, 240);
		gl.bindBuffer(gl.UNIFORM_BUFFER, null);

		// update the lighting range of the ubo
		this.lighting.updateUBO(gl, this.ubo);
	}

	public add(obj: SceneObject) {
		this.objects.push(obj);
	}

	public remove(obj: SceneObject) {
		this.objects.splice(this.objects.indexOf(obj), 1);
	}

	public draw(gl: WebGL2RenderingContext, inputManager: Input, deltaTime: number) {
		{
			// rotate camera with mouse delta
			if (inputManager.pointerLocked) {
				this.camera.yaw += inputManager.dx * MOUSE_SENSITIVITY;
				this.camera.pitch = Math.min(
					Math.PI / 2,
					Math.max(-Math.PI / 2, this.camera.pitch - inputManager.dy * MOUSE_SENSITIVITY),
				);
			}

			// get input vector
			vec2.set(
				this.input,
				(inputManager.keyDown("D") || inputManager.keyDown("d") ? 1 : 0) -
					(inputManager.keyDown("A") || inputManager.keyDown("a") ? 1 : 0),
				(inputManager.keyDown("W") || inputManager.keyDown("w") ? 1 : 0) -
					(inputManager.keyDown("S") || inputManager.keyDown("s") ? 1 : 0),
			);
			vec2.normalize(this.input, this.input);

			// update acceleration, velocity and position
			vec3.scale(this.accel, this.camera.right, -this.input[0]);
			vec3.scale(this.accelY, this.camera.forward, this.input[1]);
			vec3.add(this.accel, this.accel, this.accelY);

			vec3.set(
				this.vel,
				Math.min(MAX_VEL, Math.max(-MAX_VEL, this.vel[0] + (this.accel[0] - this.vel[0]) * ACCEL * deltaTime)),
				Math.min(MAX_VEL, Math.max(-MAX_VEL, this.vel[1] + (this.accel[1] - this.vel[1]) * ACCEL * deltaTime)),
				Math.min(MAX_VEL, Math.max(-MAX_VEL, this.vel[2] + (this.accel[2] - this.vel[2]) * ACCEL * deltaTime)),
			);

			vec3.scaleAndAdd(this.camera.position, this.camera.position, this.vel, 0.01 * deltaTime);

			this.monke.transform.position[1] = Math.sin(performance.now() / 200) * 0.1 + 1.0;
			this.monke.transform.rotation[0] = performance.now() / 100;
			this.monke.transform.rotation[1] = performance.now() / 100;
			this.monke.transform.rotation[2] = performance.now() / 100;
			this.monke.transform.update(gl);
		}

		if (gl.canvas.width != window.innerWidth || gl.canvas.height != window.innerHeight) {
			this.resize(gl);
		}

		// update camera
		this.camera.update(gl);

		// update global ubo
		this.cameraUboBuffer.set(this.camera.position);
		this.cameraUboBuffer.set(this.camera.viewProjMatrix, 4);
		gl.bindBuffer(gl.UNIFORM_BUFFER, this.ubo);
		gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.cameraUboBuffer);
		gl.bindBuffer(gl.UNIFORM_BUFFER, null);

		if (!this.lighting.loaded || !this.texturesLoaded) {
			return;
		}

		// depth prepass
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthPrepassFBO);
		gl.depthFunc(gl.LEQUAL);
		gl.enable(gl.DEPTH_TEST);
		gl.clearColor(1.0, 1.0, 1.0, 1.0);
		gl.clearDepth(1.0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		this.drawScene(gl, true);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

		// blit the depth prepass texture
		gl.disable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.depthPrepassFBO);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.depthResolveFBO);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.blitFramebuffer(
			0,
			0,
			gl.canvas.width,
			gl.canvas.height,
			0,
			0,
			gl.canvas.width,
			gl.canvas.height,
			gl.COLOR_BUFFER_BIT,
			gl.NEAREST,
		);

		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.colorMask(true, true, true, true);
		gl.bindVertexArray(null);

		// ssao
		gl.disable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoFBO);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ssaoTexture, 0);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.clearColor(0.0, 0.0, 0.0, 1.0);
		gl.clearDepth(1.0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.shaders.ssao.program);
		gl.activeTexture(gl.TEXTURE9);
		gl.uniform1i(this.shaders.ssao.uniforms.depth_map, 9);
		gl.bindTexture(gl.TEXTURE_2D, this.depthPrepassTexture);
		gl.activeTexture(gl.TEXTURE10);
		gl.uniform1i(this.shaders.ssao.uniforms.noise_map, 10);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoNoiseTexture);
		gl.uniform3fv(this.shaders.ssao.uniforms.kernel, this.ssaoKernel);
		gl.uniformMatrix4fv(this.shaders.ssao.uniforms.proj_matrix, false, this.camera.projMatrix);
		gl.uniformMatrix4fv(this.shaders.ssao.uniforms.proj_matrix_inverse, false, this.camera.projMatrixInverse);
		gl.uniform2f(this.shaders.ssao.uniforms.noise_scale, gl.canvas.width / 4.0, gl.canvas.height / 4.0);

		gl.bindBuffer(gl.ARRAY_BUFFER, this.ssaoQuadVertexBuffer);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);

		// ssao blur
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoFBO);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ssaoBlurTexture, 0);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.clearColor(0.0, 0.0, 0.0, 1.0);
		gl.clearDepth(1.0);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.shaders.ssaoBlur.program);
		gl.activeTexture(gl.TEXTURE11);
		gl.uniform1i(this.shaders.ssaoBlur.uniforms.ssao_map, 11);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoTexture);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.ssaoQuadVertexBuffer);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		gl.activeTexture(gl.TEXTURE12);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoBlurTexture);
		gl.enable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		// draw the scene
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.drawFBO);
		gl.depthFunc(gl.LEQUAL);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.useProgram(this.shaders.diffuse.program);
		gl.activeTexture(gl.TEXTURE9);
		gl.uniform1i(this.shaders.diffuse.uniforms.depth_map, 9);
		gl.bindTexture(gl.TEXTURE_2D, this.depthPrepassTexture);
		gl.activeTexture(gl.TEXTURE10);
		gl.uniform1i(this.shaders.diffuse.uniforms.noise_map, 10);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoNoiseTexture);
		gl.uniform3fv(this.shaders.diffuse.uniforms.kernel, this.ssaoKernel);
		gl.uniformMatrix4fv(this.shaders.diffuse.uniforms.proj_matrix, false, this.camera.projMatrix);
		gl.uniformMatrix4fv(this.shaders.diffuse.uniforms.proj_matrix_inverse, false, this.camera.projMatrixInverse);
		gl.uniform2f(this.shaders.diffuse.uniforms.noise_scale, gl.canvas.width / 4.0, gl.canvas.height / 4.0);
		this.drawScene(gl, false);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

		// blit
		gl.disable(gl.DEPTH_TEST);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.drawFBO);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.postFBO);
		gl.readBuffer(gl.COLOR_ATTACHMENT0);
		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.blitFramebuffer(
			0,
			0,
			gl.canvas.width,
			gl.canvas.height,
			0,
			0,
			gl.canvas.width,
			gl.canvas.height,
			gl.COLOR_BUFFER_BIT,
			gl.NEAREST,
		);

		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
		gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);

		// // draw post process
		gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

		gl.useProgram(this.shaders.postFX.program);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVertexBuffer);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	private drawScene(gl: WebGL2RenderingContext, depthOnly: boolean) {
		// draw objects
		for (const obj of this.objects.values()) {
			obj.draw && obj.draw(gl, this, this.camera, depthOnly);
		}

		// draw skybox
		if (!depthOnly) {
			this.lighting.draw(gl);
		}
	}

	private updateFramebuffers(gl: WebGL2RenderingContext) {
		const width = gl.canvas.width;
		const height = gl.canvas.height;

		// updates the buffers for the post fx pass
		// kinda sketchy since webgl doesn't have multisample textures
		const msaa = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
		const colorBuffer = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, colorBuffer);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaa, gl.RGBA16F, width, height);

		const depthBuffer = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaa, gl.DEPTH_COMPONENT16, width, height);

		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.drawFBO);
		gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorBuffer);
		gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);

		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

		const drawTexture = gl.createTexture();
		gl.activeTexture(gl.TEXTURE8);
		gl.bindTexture(gl.TEXTURE_2D, drawTexture);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, width, height);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.postFBO);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, drawTexture, 0);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		// updates the fbo/texture for the depth pass
		const depthPassColorBuffer = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, depthPassColorBuffer);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaa, gl.RGBA32F, width, height);

		const depthPassDepthBuffer = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, depthPassDepthBuffer);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msaa, gl.DEPTH_COMPONENT16, width, height);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthPrepassFBO);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, depthPassColorBuffer);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthPassDepthBuffer);

		gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		this.depthPrepassTexture = gl.createTexture();
		gl.activeTexture(gl.TEXTURE9);
		gl.bindTexture(gl.TEXTURE_2D, this.depthPrepassTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.depthResolveFBO);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.depthPrepassTexture, 0);

		gl.bindFramebuffer(gl.FRAMEBUFFER, null);

		// updates the fbo/texture for the ssao pass
		gl.activeTexture(gl.TEXTURE11);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindTexture(gl.TEXTURE_2D, null);

		gl.activeTexture(gl.TEXTURE12);
		gl.bindTexture(gl.TEXTURE_2D, this.ssaoBlurTexture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.FLOAT, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindTexture(gl.TEXTURE_2D, null);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoFBO);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ssaoTexture, 0);

		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	}

	private resize(gl: WebGL2RenderingContext) {
		gl.canvas.width = window.innerWidth;
		gl.canvas.height = window.innerHeight;
		gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
		this.updateFramebuffers(gl);
	}
}
