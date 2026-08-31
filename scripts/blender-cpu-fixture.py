# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
# ─── How to run ───
# docker run --rm --network none --entrypoint /usr/bin/blender \
#   -v "$PWD/scripts:/fixture:ro" -v "$OUTPUT_DIR:/output" \
#   lscr.io/linuxserver/blender@sha256:d1d01373e76c2dc678cb20dd38af4416daaa6ae583fa2458faa54e4f10d0c1b2 \
#   --background --factory-startup --disable-autoexec --python-exit-code 1 \
#   --python /fixture/blender-cpu-fixture.py -- /output/cpu-fixture.png

from typing import Final
import sys

import bpy

OUTPUT_PATH: Final[str] = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))

material = bpy.data.materials.new("fixture-material")
material.diffuse_color = (0.25, 0.5, 0.75, 1.0)
bpy.context.object.data.materials.append(material)

light_data = bpy.data.lights.new(name="fixture-light", type="AREA")
light_data.energy = 500
light = bpy.data.objects.new(name="fixture-light", object_data=light_data)
bpy.context.collection.objects.link(light)
light.location = (3, -4, 5)

camera_data = bpy.data.cameras.new("fixture-camera")
camera = bpy.data.objects.new("fixture-camera", camera_data)
bpy.context.collection.objects.link(camera)
camera.location = (3, -5, 3)
camera.rotation_euler = (1.1, 0.0, 0.55)

scene = bpy.context.scene
scene.camera = camera
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.seed = 7
scene.cycles.samples = 16
scene.cycles.use_adaptive_sampling = False
scene.cycles.use_denoising = False
scene.render.resolution_x = 32
scene.render.resolution_y = 32
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
scene.render.threads_mode = "FIXED"
scene.render.threads = 1
scene.render.filepath = OUTPUT_PATH

bpy.ops.render.render(write_still=True)
