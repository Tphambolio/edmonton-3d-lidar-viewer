# SketchUp Ruby script — import SKP, export DAE, quit.
# Template variables __IMPORT_FILE__ and __EXPORT_FILE__ are replaced at runtime.
#
# Runs inside SketchUp 8 via: SketchUp.exe -RubyStartup "Z:\path\to\this.rb"
#
# Based on: github.com/lcorbasson/docker-skp2dae (AGPL-3.0)

$IMPORT_FILE = "__IMPORT_FILE__"
$EXPORT_FILE = "__EXPORT_FILE__"

# Safe shutdown method by Dan Rathbun (Public Domain)
module Sketchup
  unless method_defined?(:app_safe_shutdown)
    if RUBY_PLATFORM.downcase.include?('mswin')
      def app_safe_shutdown
        send_action(57665)  # SketchUp 7/8 quit action
      end
      module_function(:app_safe_shutdown)
    end
  end
end

# Perform the conversion
model = Sketchup.active_model
show_summary = false

# Import the SKP file
status = model.import("#{$IMPORT_FILE}", show_summary)
puts("Import: #{status}")

if !status
  puts("ERROR: Import failed for #{$IMPORT_FILE}")
  Sketchup::app_safe_shutdown
end

# Export as COLLADA DAE with triangulated faces
options_hash = {
  :triangulated_faces   => true,
  :doublesided_faces    => true,
  :edges                => false,
  :author_attribution   => false,
  :texture_maps         => true,
  :selectionset_only    => false,
  :preserve_instancing  => false
}
status = model.export("#{$EXPORT_FILE}", options_hash)
puts("Export: #{status}")

if !status
  puts("ERROR: Export failed for #{$EXPORT_FILE}")
end

# Quit SketchUp
Sketchup::app_safe_shutdown
