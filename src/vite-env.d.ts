/// <reference types="vite/client" />

declare module '*.mjs?url' {
  const url: string
  export default url
}
