import { compile, env } from '@tailwindcss/node'
import { clearRequireCache } from '@tailwindcss/node/require-cache'
import { Scanner } from '@tailwindcss/oxide'
import fs from 'fs'
import { Features, transform } from 'lightningcss'
import path from 'path'
import postcss, { type AcceptedPlugin, type PluginCreator } from 'postcss'
import fixRelativePathsPlugin from './postcss-fix-relative-paths'

/**
 * A Map that can generate default values for keys that don't exist.
 * Generated default values are added to the map to avoid recomputation.
 */
class DefaultMap<T = string, V = any> extends Map<T, V> {
  constructor(private factory: (key: T, self: DefaultMap<T, V>) => V) {
    super()
  }

  get(key: T): V {
    let value = super.get(key)

    if (value === undefined) {
      value = this.factory(key, this)
      this.set(key, value)
    }

    return value
  }
}

export type PluginOptions = {
  // The base directory to scan for class candidates.
  base?: string

  // Optimize and minify the output CSS.
  optimize?: boolean | { minify?: boolean }
}

function tailwindcss(opts: PluginOptions = {}): AcceptedPlugin {
  let base = opts.base ?? process.cwd()
  let optimize = opts.optimize ?? process.env.NODE_ENV === 'production'

  let cache = new DefaultMap(() => {
    return {
      mtimes: new Map<string, number>(),
      compiler: null as null | Awaited<ReturnType<typeof compile>>,
      css: '',
      optimizedCss: '',
      fullRebuildPaths: [] as string[],
    }
  })

  return {
    postcssPlugin: '@tailwindcss/postcss',
    plugins: [
      // We need to handle the case where `postcss-import` might have run before the Tailwind CSS
      // plugin is run. In this case, we need to manually fix relative paths before processing it
      // in core.
      fixRelativePathsPlugin(),

      {
        postcssPlugin: 'tailwindcss',
        async OnceExit(root, { result }) {
          env.DEBUG && console.time('[@tailwindcss/postcss] Total time in @tailwindcss/postcss')
          let inputFile = result.opts.from ?? ''
          let context = cache.get(inputFile)
          let inputBasePath = path.dirname(path.resolve(inputFile))

          async function createCompiler() {
            env.DEBUG && console.time('[@tailwindcss/postcss] Setup compiler')
            clearRequireCache(context.fullRebuildPaths)

            context.fullRebuildPaths = []

            let compiler = compile(root.toString(), {
              base: inputBasePath,
              onDependency: (path) => {
                context.fullRebuildPaths.push(path)
              },
            })

            env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Setup compiler')
            return compiler
          }

          // Setup the compiler if it doesn't exist yet. This way we can
          // guarantee a `build()` function is available.
          context.compiler ??= await createCompiler()

          let rebuildStrategy: 'full' | 'incremental' = 'incremental'

          // Track file modification times to CSS files
          {
            for (let file of context.fullRebuildPaths) {
              result.messages.push({
                type: 'dependency',
                plugin: '@tailwindcss/postcss',
                file,
                parent: result.opts.from,
              })
            }

            let files = result.messages.flatMap((message) => {
              if (message.type !== 'dependency') return []
              return message.file
            })
            files.push(inputFile)

            for (let file of files) {
              let changedTime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null
              if (changedTime === null) {
                if (file === inputFile) {
                  rebuildStrategy = 'full'
                }
                continue
              }

              let prevTime = context.mtimes.get(file)
              if (prevTime === changedTime) continue

              rebuildStrategy = 'full'
              context.mtimes.set(file, changedTime)
            }
          }

          let css = ''

          // Look for candidates used to generate the CSS
          let scanner = new Scanner({
            detectSources: { base },
            sources: context.compiler.globs,
          })

          env.DEBUG && console.time('[@tailwindcss/postcss] Scan for candidates')
          let candidates = scanner.scan()
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Scan for candidates')

          // Add all found files as direct dependencies
          for (let file of scanner.files) {
            result.messages.push({
              type: 'dependency',
              plugin: '@tailwindcss/postcss',
              file,
              parent: result.opts.from,
            })
          }

          // Register dependencies so changes in `base` cause a rebuild while
          // giving tools like Vite or Parcel a glob that can be used to limit
          // the files that cause a rebuild to only those that match it.
          for (let { base, pattern } of scanner.globs) {
            result.messages.push({
              type: 'dir-dependency',
              plugin: '@tailwindcss/postcss',
              dir: base,
              glob: pattern,
              parent: result.opts.from,
            })
          }

          if (rebuildStrategy === 'full') {
            context.compiler = await createCompiler()
          }

          env.DEBUG && console.time('[@tailwindcss/postcss] Build CSS')
          css = context.compiler.build(candidates)
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Build CSS')

          // Replace CSS
          if (css !== context.css && optimize) {
            env.DEBUG && console.time('[@tailwindcss/postcss] Optimize CSS')
            context.optimizedCss = optimizeCss(css, {
              minify: typeof optimize === 'object' ? optimize.minify : true,
            })
            env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Optimize CSS')
          }
          context.css = css

          env.DEBUG && console.time('[@tailwindcss/postcss] Update PostCSS AST')
          root.removeAll()
          root.append(postcss.parse(optimize ? context.optimizedCss : context.css, result.opts))
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Update PostCSS AST')
          env.DEBUG && console.timeEnd('[@tailwindcss/postcss] Total time in @tailwindcss/postcss')
        },
      },
    ],
  }
}

function optimizeCss(
  input: string,
  { file = 'input.css', minify = false }: { file?: string; minify?: boolean } = {},
) {
  return transform({
    filename: file,
    code: Buffer.from(input),
    minify,
    sourceMap: false,
    drafts: {
      customMedia: true,
    },
    nonStandard: {
      deepSelectorCombinator: true,
    },
    include: Features.Nesting,
    exclude: Features.LogicalProperties,
    targets: {
      safari: (16 << 16) | (4 << 8),
    },
    errorRecovery: true,
  }).code.toString()
}

export default Object.assign(tailwindcss, { postcss: true }) as PluginCreator<PluginOptions>
