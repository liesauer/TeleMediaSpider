export type RecursivePartial<T> = {
    [P in keyof T]?:
        T[P] extends (infer U)[] ? RecursivePartial<U>[] :
        T[P] extends object ? RecursivePartial<T[P]> :
        T[P];
}

export interface AnnotatedDictionary<T, KeyAnnotate extends string> {
    [index: string]: T;
}

export interface NumericDictionary<T> {
    [index: number]: T;
}

export type AnnotatedDoubleDictionary<T, KeyAnnotate1 extends string, KeyAnnotate2 extends string> = AnnotatedDictionary<AnnotatedDictionary<T, KeyAnnotate2>, KeyAnnotate1>

export type UnwrapNumericDictionaryType<T> = T extends NumericDictionary<infer U> ? U : never

export type ArrayValueType<T> = T extends Array<infer V> ? V : any;
