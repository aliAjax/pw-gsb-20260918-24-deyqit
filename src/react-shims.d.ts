/**
 * 本地 React 类型垫片：项目未安装 @types/react，且不新增 npm 依赖。
 * 仅声明本应用实际用到的 React API 与 JSX 运行时类型。
 * 本文件必须保持为全局脚本（无顶层 import/export），ambient 声明才会全局生效。
 */

declare module "react" {
  export type ReactNode = unknown;
  export type ChangeEvent<T = Element> = { target: T };

  export interface Dispatch<A> {
    (value: A): void;
  }

  export type SetStateAction<S> = S | ((prev: S) => S);

  export function useState<S>(
    initial: S | (() => S)
  ): [S, Dispatch<SetStateAction<S>>];
  export function useState<S = undefined>(): [
    S | undefined,
    Dispatch<SetStateAction<S | undefined>>
  ];

  export function useEffect(
    effect: () => void | (() => void),
    deps?: readonly unknown[]
  ): void;

  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T;

  export type FC<P = Record<string, unknown>> = (props: P) => JSX.Element | null;
  export const StrictMode: FC<{ children?: unknown }>;
}

declare module "react/jsx-runtime" {
  export const Fragment: unique symbol;
  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export const jsxs: typeof jsx;
}

declare module "react-dom/client" {
  export function createRoot(container: Element): {
    render(node: unknown): void;
  };
}

declare namespace JSX {
  interface Element {}
  interface ElementClass {}
  interface ElementAttributesProperty {
    props: unknown;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
  type LibraryManagedAttributes<C, P> = P;
  interface IntrinsicAttributes {
    key?: string | number;
  }
  interface IntrinsicElements {
    [elem: string]: any;
  }
}
