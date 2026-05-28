import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_DEPENDENCIES,
  buildDefaultManifest,
  htmlHasInlineImportMap,
  isBareSpecifier,
  findBareModuleImports,
  mergeDependenciesIntoManifest,
} from '@/server/services/mini-app-deps'

describe('mini-app-deps', () => {
  describe('buildDefaultManifest', () => {
    it('serializes the default react stack', () => {
      const parsed = JSON.parse(buildDefaultManifest())
      expect(parsed.dependencies).toEqual(DEFAULT_DEPENDENCIES)
      expect(parsed.dependencies.react).toBeDefined()
      expect(parsed.dependencies['react-dom/client']).toBeDefined()
      expect(parsed.dependencies['@kinbot/react']).toBeDefined()
      expect(parsed.dependencies['@kinbot/components']).toBeDefined()
    })
  })

  describe('isBareSpecifier', () => {
    it('treats package names as bare', () => {
      expect(isBareSpecifier('react')).toBe(true)
      expect(isBareSpecifier('react-dom/client')).toBe(true)
      expect(isBareSpecifier('@kinbot/react')).toBe(true)
    })
    it('treats paths and URLs as non-bare', () => {
      expect(isBareSpecifier('./utils.js')).toBe(false)
      expect(isBareSpecifier('../lib/x.js')).toBe(false)
      expect(isBareSpecifier('/api/mini-apps/sdk/x.js')).toBe(false)
      expect(isBareSpecifier('https://esm.sh/react@19')).toBe(false)
      expect(isBareSpecifier('data:text/javascript,')).toBe(false)
      expect(isBareSpecifier('')).toBe(false)
    })
  })

  describe('htmlHasInlineImportMap', () => {
    it('detects an inline importmap', () => {
      expect(htmlHasInlineImportMap('<script type="importmap">{}</script>')).toBe(true)
      expect(htmlHasInlineImportMap("<script type='importmap'>{}</script>")).toBe(true)
    })
    it('returns false without one', () => {
      expect(htmlHasInlineImportMap('<script type="module">x</script>')).toBe(false)
    })
  })

  describe('findBareModuleImports', () => {
    it('finds bare specifiers in text/jsx and module scripts', () => {
      const html = `
        <script type="text/jsx">
          import React from "react";
          import { createRoot } from "react-dom/client";
        </script>
        <script type="module">
          import { thing } from "@kinbot/react";
          import "./local.js";
          import x from "https://esm.sh/x";
        </script>
      `
      const found = findBareModuleImports(html)
      expect(found.sort()).toEqual(['@kinbot/react', 'react', 'react-dom/client'])
    })

    it('handles dynamic and side-effect imports', () => {
      const html = '<script type="module">import("lodash"); import "polyfill";</script>'
      const found = findBareModuleImports(html)
      expect(found.sort()).toEqual(['lodash', 'polyfill'])
    })

    it('ignores imports outside module/jsx scripts', () => {
      const html = '<script>import x from "react"</script>'
      expect(findBareModuleImports(html)).toEqual([])
    })

    it('returns empty for plain HTML', () => {
      expect(findBareModuleImports('<h1>Hello</h1>')).toEqual([])
    })
  })

  describe('mergeDependenciesIntoManifest', () => {
    it('creates a fresh manifest when none exists', () => {
      const out = JSON.parse(mergeDependenciesIntoManifest(undefined, { react: 'x' }))
      expect(out.dependencies.react).toBe('x')
    })

    it('merges into existing dependencies (new keys win)', () => {
      const existing = JSON.stringify({ dependencies: { react: 'old', foo: 'bar' } })
      const out = JSON.parse(mergeDependenciesIntoManifest(existing, { react: 'new' }))
      expect(out.dependencies.react).toBe('new')
      expect(out.dependencies.foo).toBe('bar')
    })

    it('merges into importmap.imports when that form is used', () => {
      const existing = JSON.stringify({ importmap: { imports: { react: 'old' } } })
      const out = JSON.parse(mergeDependenciesIntoManifest(existing, { vue: 'v' }))
      expect(out.importmap.imports.react).toBe('old')
      expect(out.importmap.imports.vue).toBe('v')
    })

    it('falls back to a fresh manifest on malformed JSON', () => {
      const out = JSON.parse(mergeDependenciesIntoManifest('not json{', { react: 'x' }))
      expect(out.dependencies.react).toBe('x')
    })
  })
})
