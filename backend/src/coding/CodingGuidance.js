/** Application-owned coding guidance. Project documents remain untrusted task data. */
export function codingGuidance(goal) {
  const common =
    'Inspect, implement, run checks, fix errors and rerun. Read current SHA before edits; new means create-only. Search accepts files/directories. Never repeat an identical read-only call: in an empty project start creating files with fs.write now. Check runtimes/permissions with runtime.inspect. Use exec.run/tests.run for checks, exec.start for GUI/servers, exec.output for real logs, exec.stop to stop. Use deps.install (npm, pip, cargo, go, dotnet) for missing packages and runtime.install (python, rust, go, dotnet) for a missing language runtime, with approval. Disabled tools cannot be bypassed. Finish only after required checks pass.';
  const python = /\bpython|calculator|tkinter\b/i.test(goal)
    ? ' Python: use tkinter/ttk for desktop calculators (included with Windows Python, not pip). Separate logic/UI, handle invalid input/zero division, avoid eval, guard main so tests can import. Write unittest cases; run python -m py_compile on changed .py files. Run unittest discover -s <test-directory>; confirm tests were actually found. GUI apps use exec.start, never foreground validation.'
    : '';
  const web = /\breact|vite|tailwind|website|web app|frontend\b/i.test(goal)
    ? ' Web: inspect package.json versions. Never invent version numbers: when unsure write "latest" in package.json. If deps.install reports PACKAGE_VERSION_NOT_FOUND, fix that entry in package.json and run deps.install again. React/Vite layout: package.json, index.html and vite.config.js in the project ROOT (never index.html inside src/); src/main.jsx, src/App.jsx, src/App.css inside src/. index.html contains <div id="root"></div> and <script type="module" src="/src/main.jsx"></script>. Write each file once, never rewrite an unchanged file; use createRoot imported from "react-dom/client" (not "react-dom"). Write package.json (with scripts dev/build/preview) BEFORE any deps.install; never deps.install packages into a folder without package.json.' +
      (/\btailwind/i.test(goal)
        ? ' Tailwind v4: @tailwindcss/vite and @import "tailwindcss"; preserve existing v3.'
        : ' Do not add Tailwind or other UI libraries unless the request asks for them.') +
      ' deps.install npm, npm run build, then exec.start npm run dev -- --host 127.0.0.1 --port 5175 --strictPort with port=5175. Use a free port and real preview URL.'
    : '';
  const threeD = /\bthree(?:\.?js)?\b|\bwebgl\b|\b3d\b|\bgltf\b|\bglb\b/i.test(goal)
    ? ' 3D (Three.js): Vite project with index.html, src/main.js and package.json listing three and vite; deps.install npm three vite, import from "three" and "three/addons/..." (OrbitControls, GLTFLoader). Build one scene, PerspectiveCamera, WebGLRenderer sized to the canvas with setPixelRatio(min(devicePixelRatio, 2)), lights, and an animation loop with renderer.setAnimationLoop. Resize on window resize (camera.aspect, updateProjectionMatrix, renderer.setSize). Build models from primitives/BufferGeometry or load local .glb files under public/; never fetch remote assets. Dispose geometries, materials and textures you replace. npm run build must pass, then exec.start npm run dev -- --host 127.0.0.1 --port 5175 --strictPort with port=5175 and give the preview URL.'
    : '';
  const rust = /\brust|cargo|crate\b/i.test(goal)
    ? ' Rust: write Cargo.toml ([package] name/version/edition="2021") and src/main.rs yourself; cargo init/new are unavailable. deps.install cargo with crate names, then deps.install cargo again with no packages to download them. Builds are offline: exec.run cargo build / cargo test / cargo run. cargo needs the Rust toolchain (runtime.install rust) and MSVC build tools.'
    : '';
  const go = /\bgolang\b|\bgo (?:program|app|module|cli|server|project|code)|\bgo\.mod\b/i.test(
    goal,
  )
    ? ' Go: write go.mod (module name, go version) and main.go yourself; go mod init is unavailable. deps.install go with module paths to fetch them, then exec.run go build ./... / go test ./... / go run . . go -ldflags, -toolexec and go get/install are blocked.'
    : '';
  const dotnet = /\bc#|\bcsharp\b|\.net\b|\bdotnet\b|\basp\.?net\b|\bblazor\b|\bnuget\b/i.test(goal)
    ? ' .NET: dotnet new is unavailable. Write the .csproj (Sdk="Microsoft.NET.Sdk" or Microsoft.NET.Sdk.Web for ASP.NET, TargetFramework net10.0) and Program.cs yourself. deps.install dotnet restores (omit packages) or adds one NuGet package per call. Always restore first: build/run/test use --no-restore. ASP.NET: exec.start dotnet run with port=<n> binds 127.0.0.1:<n>; launch profiles are ignored.'
    : '';
  const java = /\bjava\b(?!script)|\bmaven\b|\bgradle\b|\bspring\b|\bjdk\b/i.test(goal)
    ? ' Java: needs the JDK (runtime.install java). Maven: write pom.xml (maven-compiler-plugin release 21, junit for tests) and src/main/java yourself; Gradle: build.gradle.kts. Runtime maven/gradle install a checksum-verified distribution. Build with exec.run mvn test / mvn package or gradle build; deps.install maven/gradle prefetches (no package names: edit the build file). Maven and Gradle download dependencies while building, so package downloads must be on. Single files: exec.run javac -d out ... then java -cp out Main.'
    : '';
  const cpp = /\bc\+\+|\bcpp\b|\bcmake\b|\bconan\b|\bvcpkg\b|\bmakefile\b|\bgcc\b/i.test(goal)
    ? ' C/C++: runtime.install cmake, ninja and mingw (GCC). Write CMakeLists.txt, then exec.run cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release, cmake --build build, ctest --test-dir build --output-on-failure. Direct: gcc/g++ -o app.exe main.c; mingw32-make. Libraries: write conanfile.txt and deps.install conan (run conan profile detect first), or vcpkg.json with deps.install vcpkg (vcpkg must already be installed). cmake -E, -P, --install and compiler launchers are blocked.'
    : '';
  const sql = /\bsql\b|\bsqlite\b|\bpostgres|\bpsql\b|\bdatabase\b|\bschema\b/i.test(goal)
    ? ' SQL: write .sql files; run SQLite with exec.run sqlite3 app.db schema.sql (a .sql file argument is inlined, 24,000 characters at most) or sqlite3 app.db "select ...". sqlite3 runs in safe mode: no ATTACH, .shell, .read, writefile or extensions. PostgreSQL: psql only connects to 127.0.0.1/localhost (-U, -d, -c, -f) using the password in pgpass.conf; the server must already be running; psql meta-commands such as \\! and \\o are refused.'
    : '';
  const embedded =
    /\bembedded\b|\barm\b|\bcortex|\bstm32\b|\bmicrocontroller|\bfirmware\b|\bmcu\b/i.test(goal)
      ? ' Embedded C (build only): runtime.install arm, cmake, ninja. Compile with arm-none-eabi-gcc -mcpu=cortex-m4 -mthumb -specs=nano.specs -T linker.ld ... -o firmware.elf, then arm-none-eabi-size firmware.elf and arm-none-eabi-objcopy -O binary firmware.elf firmware.bin. Only the built-in nano/nosys/rdimon specs are allowed. Flashing or debugging hardware is not available; say so instead of claiming it ran on a device.'
      : '';
  return common + python + web + threeD + rust + go + dotnet + java + cpp + sql + embedded;
}
