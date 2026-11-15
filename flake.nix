{
  description = "Iris — React/Vite frontend with pnpm and FastAPI backend with uv";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312;

        # uv installs Python dependencies from uv.lock. These libraries allow
        # manylinux wheels (numpy, scipy, astropy, etc.) to load on NixOS and
        # also support possible local builds.
        runtimeLibraries = with pkgs; [
          stdenv.cc.cc.lib
          zlib
          openssl
          libffi
          bzip2
          xz
        ];

        # Applied when patching the uv venv RPATH, but never exported on
        # LD_LIBRARY_PATH. NSS resolves libsqlite3.so through its own RPATH,
        # and a dev shell copy shadows it, aborting every Electron and
        # Chromium app at startup (FATAL:crypto/nss_util, nss_error=-5925).
        rpathOnlyLibraries = with pkgs; [ sqlite ];

        libraryPath = pkgs.lib.makeLibraryPath (runtimeLibraries ++ rpathOnlyLibraries);
        nixLdLibraryPath = pkgs.lib.makeLibraryPath (
          runtimeLibraries
          ++ rpathOnlyLibraries
          ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux pkgs.glibc
        );

        # Subset exported as LD_LIBRARY_PATH by the dev shell, kept free of
        # libraries that other programs must resolve through their own RPATH.
        shellLibraryPath = pkgs.lib.makeLibraryPath runtimeLibraries;
        pkgConfigPath = pkgs.lib.makeSearchPath "lib/pkgconfig" (
          with pkgs;
          [
            openssl.dev
            zlib.dev
            libffi.dev
            sqlite.dev
          ]
        );

        # Some tools in uv's dev dependency group (especially ruff) are
        # downloaded as manylinux executables. On NixOS, change their ELF
        # interpreter while preserving any RPATH included in the wheel.
        patchUvVenv =
          if pkgs.stdenv.hostPlatform.isLinux then
            pkgs.writeShellScript "iris-patch-uv-venv" ''
              venv_path="''${UV_PROJECT_ENVIRONMENT:-.venv}"
              if [ -z "''${UV_PROJECT_ENVIRONMENT:-}" ] && [ ! -d "$venv_path" ] && [ -d apps/server/.venv ]; then
                venv_path=apps/server/.venv
              fi
              case "$venv_path" in
                /*) ;;
                *) venv_path="$PWD/$venv_path" ;;
              esac

              [ -d "$venv_path/bin" ] || exit 0

              for executable in "$venv_path"/bin/*; do
                [ -f "$executable" ] || continue
                [ -L "$executable" ] && continue

                interpreter="$(${pkgs.patchelf}/bin/patchelf --print-interpreter "$executable" 2>/dev/null || true)"
                [ -n "$interpreter" ] || continue

                if [ "$interpreter" != "${pkgs.stdenv.cc.bintools.dynamicLinker}" ]; then
                  ${pkgs.patchelf}/bin/patchelf \
                    --set-interpreter "${pkgs.stdenv.cc.bintools.dynamicLinker}" \
                    "$executable" 2>/dev/null || continue
                fi

                original_rpath="$(${pkgs.patchelf}/bin/patchelf --print-rpath "$executable" 2>/dev/null || true)"
                if [ -n "$original_rpath" ]; then
                  rpath="$original_rpath:${nixLdLibraryPath}"
                else
                  rpath="${nixLdLibraryPath}"
                fi
                ${pkgs.patchelf}/bin/patchelf --set-rpath "$rpath" "$executable" 2>/dev/null || true
              done

              # VS Code can launch the venv's Python without inheriting the
              # dev shell's LD_LIBRARY_PATH. Give native Python extensions
              # their own Nix library search path as well.
              if [ -d "$venv_path/lib" ]; then
                while IFS= read -r -d ''' library; do
                  original_rpath="$(${pkgs.patchelf}/bin/patchelf --print-rpath "$library" 2>/dev/null)" || continue
                  case ":$original_rpath:" in
                    *":${libraryPath}:"*) continue ;;
                  esac
                  if [ -n "$original_rpath" ]; then
                    rpath="$original_rpath:${libraryPath}"
                  else
                    rpath="${libraryPath}"
                  fi
                  ${pkgs.patchelf}/bin/patchelf --set-rpath "$rpath" "$library"
                done < <(${pkgs.findutils}/bin/find "$venv_path/lib" -type f \( -name '*.so' -o -name '*.so.*' \) -print0)
              fi
            ''
          else
            pkgs.writeShellScript "iris-patch-uv-venv" ''
              exit 0
            '';
      in
      {
        devShells.default = pkgs.mkShell {
          packages =
            with pkgs;
            [
              git
              nodejs_24
              pnpm
              python
              uv
              pkg-config
              stdenv.cc
            ]
            ++ pkgs.lib.optional pkgs.stdenv.hostPlatform.isLinux patchelf;

          env = {
            # Make uv use the Python interpreter provided by Nix instead of
            # downloading another Python or selecting one from the system.
            UV_PYTHON = "${python}/bin/python3.12";
            UV_PYTHON_PREFERENCE = "only-system";
            PYTHONNOUSERSITE = "1";

            # The project's packageManager declares pnpm 12.11.2. Nix already
            # provides pnpm 12.x; prevent pnpm from downloading an external
            # native binary that cannot run directly on NixOS.
            npm_config_manage_package_manager_versions = "false";

            # NIX_LD is useful when the system has nix-ld enabled. The
            # LD_LIBRARY_PATH defined below in shellHook covers shared
            # extensions loaded directly by scientific packages installed by uv.
            PKG_CONFIG_PATH = pkgConfigPath;
          }
          // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            NIX_LD = "${pkgs.stdenv.cc.bintools.dynamicLinker}";
            NIX_LD_LIBRARY_PATH = nixLdLibraryPath;
          };

          shellHook = ''
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export LD_LIBRARY_PATH="${shellLibraryPath}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            ''}

            ${patchUvVenv}
            uv() {
              ${patchUvVenv}
              command uv "$@"
              uv_status=$?
              if [ "$uv_status" -eq 0 ] && [ "$#" -gt 0 ]; then
                case "$1" in
                  sync|add|remove) ${patchUvVenv} ;;
                esac
              fi
              return "$uv_status"
            }

            echo ""
            echo "Iris dev shell"
            echo "  Node:    $(node --version)"
            echo "  pnpm:    $(pnpm --version)"
            echo "  Python:  $(${python}/bin/python3.12 --version)"
            echo "  uv:      $(uv --version)"
            echo ""
            echo "Frontend: cd apps/web && pnpm install && pnpm dev"
            echo "Backend:  cd apps/server && uv sync && uv run uvicorn app.main:app --reload"
            echo ""
          '';
        };
      }
    );
}
