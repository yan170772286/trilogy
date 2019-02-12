import { dirname, resolve } from 'path'
import { openSync, closeSync } from 'fs'

import * as knex from 'knex'

import Model from './model'
import { runQuery } from './helpers'
import { toKnexSchema, createTimestampTrigger } from './schema-helpers'
import { pureConnect, readDatabase } from './sqljs-handler'
import { defaultTo, invariant, makeDirPath } from './util'

import { Pool } from 'generic-pool'
import { Database } from 'sql.js'
import * as hooks from './hooks'
import * as types from './types'

// @ts-ignore: throwaway reference to satisfy compiler
import * as t from 'io-ts'

const ensureExists = (atPath: string) => {
  try {
    closeSync(openSync(atPath, 'wx'))
  } catch {}
}

export class Trilogy {
  isNative: boolean
  knex: knex
  options: types.TrilogyOptions
  pool?: Pool<Database>
  verbose?: (query: string) => any

  private _definitions: Map<string, Model<any>>

  constructor (path: string, options: types.TrilogyOptions = {}) {
    invariant(path, 'trilogy constructor must be provided a file path')

    const obj = this.options =
      types.validate(options, types.TrilogyOptions)

    if (path === ':memory:') {
      obj.connection!.filename = path
    } else {
      obj.connection!.filename = resolve(obj.dir as string, path)

      // ensure the directory exists
      makeDirPath(dirname(obj.connection!.filename as string))
    }

    this.isNative = obj.client === 'sqlite3'
    this.verbose = (obj.verbose as (query: string) => any)

    const config = { client: 'sqlite3', useNullAsDefault: true }

    if (this.isNative) {
      if (path !== ':memory:') {
        ensureExists(obj.connection!.filename as string)
      }

      this.knex = knex(({ ...config, connection: obj.connection } as knex.Config))
    } else {
      this.knex = knex(config)
      this.pool = pureConnect(this)
      readDatabase(this)
    }

    this._definitions = new Map()
  }

  get models () {
    return [...this._definitions.keys()]
  }

  async model <D extends types.ReturnDict = types.LooseObject> (
    name: string,
    schema: types.SchemaRaw<D>,
    options: types.ModelOptions = {}
  ): Promise<Model<D>> {
    if (this._definitions.has(name)) {
      return this._definitions.get(name) as Model<D>
    }

    const model = new Model<D>(this, name, schema, options)
    this._definitions.set(name, model)

    const opts = toKnexSchema(
      model,
      types.validate(options, types.ModelOptions, {})
    )
    const check = this.knex.schema.hasTable(name)
    const query = this.knex.schema.createTable(name, opts)

    if (this.isNative) {
      // tslint:disable-next-line:await-promise
      if (!await check) {
        await query
      }
    } else {
      if (!await runQuery(this, check, { needResponse: true })) {
        await runQuery(this, query)
      }
    }

    createTimestampTrigger(model)
    return model
  }

  getModel <D extends types.ReturnDict = types.LooseObject> (name: string): Model<D> | never {
    return invariant(
      this._definitions.get(name) as Model<D>,
      `no model defined by the name '${name}'`
    )
  }

  async hasModel (name: string): Promise<boolean> {
    if (!this._definitions.has(name)) {
      return false
    }

    const query = this.knex.schema.hasTable(name)
    return runQuery(this, query, { needResponse: true })
  }

  async dropModel (name: string): Promise<boolean> {
    if (!this._definitions.has(name)) {
      return false
    }

    const query = this.knex.schema.dropTableIfExists(name)
    await runQuery(this, query, { needResponse: true })
    this._definitions.delete(name)
    return true
  }

  raw (query: knex.QueryBuilder | knex.Raw, needResponse?: boolean) {
    return runQuery(this, query, { needResponse })
  }

  close () {
    if (this.isNative) {
      // must wrap this return value in native Promise due to
      // https://github.com/petkaantonov/bluebird/issues/1277
      return Promise.resolve(this.knex.destroy())
    } else {
      return this.pool!.drain()
    }
  }

  create <T = types.LooseObject> (
    table: string,
    object: types.LooseObject,
    options?: types.LooseObject
  ): Promise<T>
  create (
    table: string,
    object: types.LooseObject,
    options?: types.LooseObject
  ) {
    const model = this.getModel(table)
    return model.create(object, options)
  }

  find <T = types.LooseObject> (
    location: string,
    criteria?: types.Criteria,
    options?: types.FindOptions
  ): Promise<T[]>
  find (
    location: string,
    criteria?: types.Criteria,
    options?: types.FindOptions
  ) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    if (column) {
      return model.findIn(column, criteria, options)
    } else {
      return model.find(criteria, options)
    }
  }

  findOne <T = types.LooseObject> (
    location: string,
    criteria?: types.Criteria,
    options?: types.FindOptions
  ): Promise<T>
  findOne (
    location: string,
    criteria?: types.Criteria,
    options?: types.FindOptions
  ) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    if (column) {
      return model.findOneIn(column, criteria, options)
    } else {
      return model.findOne(criteria, options)
    }
  }

  findOrCreate <T = types.LooseObject> (
    table: string,
    criteria: types.Criteria,
    creation?: types.LooseObject,
    options?: types.FindOptions
  ): Promise<T>
  findOrCreate (
    table: string,
    criteria: types.Criteria,
    creation?: types.LooseObject,
    options?: types.FindOptions
  ) {
    const model = this.getModel(table)
    return model.findOrCreate(criteria, creation, options)
  }

  update (
    table: string,
    criteria: types.Criteria,
    data: types.LooseObject,
    options?: types.UpdateOptions
  ) {
    const model = this.getModel(table)
    return model.update(criteria, data, options)
  }

  updateOrCreate (
    table: string,
    criteria: types.Criteria,
    data: types.LooseObject,
    options?: types.CreateOptions & types.UpdateOptions
  ) {
    const model = this.getModel(table)
    return model.updateOrCreate(criteria, data, options)
  }

  get <T = types.ReturnType> (
    location: string,
    criteria: types.Criteria,
    defaultValue?: T
  ): Promise<T>
  get (
    location: string,
    criteria: types.Criteria,
    defaultValue?: any
  ): Promise<any> {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.get(column, criteria, defaultValue)
  }

  set <T> (location: string, criteria: types.Criteria, value: T) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.set(column, criteria, value)
  }

  getRaw <T> (location: string, criteria: types.Criteria, defaultValue: T): Promise<T>
  getRaw (location: string, criteria: types.Criteria): Promise<types.ReturnType>
  getRaw (
    location: string,
    criteria: types.Criteria,
    defaultValue?: any
  ): Promise<any> {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.getRaw(column, criteria, defaultValue)
  }

  setRaw <T> (location: string, criteria: types.Criteria, value: T) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.setRaw(column, criteria, value)
  }

  incr (location: string, criteria: types.Criteria, amount?: number) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.incr(column, criteria, amount)
  }

  decr (
    location: string,
    criteria: types.Criteria,
    amount?: number,
    allowNegative?: boolean
  ) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.decr(column, criteria, amount, allowNegative)
  }

  remove (location: string, criteria: types.Criteria) {
    const model = this.getModel(location)
    return model.remove(criteria)
  }

  clear (location: string) {
    const model = this.getModel(location)
    return model.clear()
  }

  count (
    location?: string,
    criteria?: types.Criteria,
    options?: types.AggregateOptions
  ): Promise<number> {
    if (location == null && criteria == null && options == null) {
      const query = this.knex('sqlite_master')
        .whereNot('name', 'sqlite_sequence')
        .where({ type: 'table' })
        .count('* as count')

      return runQuery(this, query, { needResponse: true })
        .then(([{ count }]) => count)
    }

    const [table, column] = defaultTo(location, '').split('.', 2)
    const model = this.getModel(table)
    return column
      ? model.countIn(column, criteria, options)
      : model.count(criteria, options)
  }

  min (location: string, criteria: types.Criteria, options?: types.AggregateOptions) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.min(column, criteria, options)
  }

  max (location: string, criteria: types.Criteria, options?: types.AggregateOptions) {
    const [table, column] = location.split('.', 2)
    const model = this.getModel(table)
    return model.max(column, criteria, options)
  }

  onQuery (callback: hooks.OnQueryCallback): types.Fn<[], boolean>[]
  onQuery (scope: string, callback: hooks.OnQueryCallback): types.Fn<[], boolean>
  onQuery (
    ...args: [hooks.OnQueryCallback] | [string, hooks.OnQueryCallback]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all queries run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel(location).onQuery(fn)
    } else {
      // all queries run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach(model => {
        unsubs[++i] = model.onQuery(fn)
      })

      return unsubs
    }
  }

  beforeCreate <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.BeforeCreateCallback<D>
  ): types.Fn<[], boolean>[]
  beforeCreate <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.BeforeCreateCallback<D>
  ): types.Fn<[], boolean>
  beforeCreate <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.BeforeCreateCallback<D>] | [string, hooks.BeforeCreateCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all creations run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).beforeCreate(fn)
    } else {
      // all creations run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach(model => {
        unsubs[++i] = model.beforeCreate(fn)
      })

      return unsubs
    }
  }

  afterCreate <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.AfterCreateCallback<D>
  ): types.Fn<[], boolean>[]
  afterCreate <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.AfterCreateCallback<D>
  ): types.Fn<[], boolean>
  afterCreate <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.AfterCreateCallback<D>] | [string, hooks.AfterCreateCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all creations run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).afterCreate(fn)
    } else {
      // all creations run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach(model => {
        unsubs[++i] = model.afterCreate(fn)
      })

      return unsubs
    }
  }

  beforeUpdate <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.BeforeUpdateCallback<D>
  ): types.Fn<[], boolean>[]
  beforeUpdate <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.BeforeUpdateCallback<D>
  ): types.Fn<[], boolean>
  beforeUpdate <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.BeforeUpdateCallback<D>] | [string, hooks.BeforeUpdateCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all updates run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).beforeUpdate(fn)
    } else {
      // all updates run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach((model: Model<D>) => {
        unsubs[++i] = model.beforeUpdate(fn)
      })

      return unsubs
    }
  }

  afterUpdate <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.AfterUpdateCallback<D>
  ): types.Fn<[], boolean>[]
  afterUpdate <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.AfterUpdateCallback<D>
  ): types.Fn<[], boolean>
  afterUpdate <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.AfterUpdateCallback<D>] | [string, hooks.AfterUpdateCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all updates run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).afterUpdate(fn)
    } else {
      // all updates run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach(model => {
        unsubs[++i] = model.afterUpdate(fn)
      })

      return unsubs
    }
  }

  beforeRemove <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.BeforeRemoveCallback<D>
  ): types.Fn<[], boolean>[]
  beforeRemove <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.BeforeRemoveCallback<D>
  ): types.Fn<[], boolean>
  beforeRemove <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.BeforeRemoveCallback<D>] | [string, hooks.BeforeRemoveCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all removals run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).beforeRemove(fn)
    } else {
      // all removals run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach((model: Model<D>) => {
        unsubs[++i] = model.beforeRemove(fn)
      })

      return unsubs
    }
  }

  afterRemove <D extends types.ReturnDict = types.LooseObject> (
    callback: hooks.AfterRemoveCallback<D>
  ): types.Fn<[], boolean>[]
  afterRemove <D extends types.ReturnDict = types.LooseObject> (
    scope: string, callback: hooks.AfterRemoveCallback<D>
  ): types.Fn<[], boolean>
  afterRemove <D extends types.ReturnDict = types.LooseObject> (
    ...args: [hooks.AfterRemoveCallback<D>] | [string, hooks.AfterRemoveCallback<D>]
  ): types.Fn<[], boolean>[] | (types.Fn<[], boolean>) {
    if (args.length === 2) {
      // all removals run on the model identified by `scope`
      const [location, fn] = args
      return this.getModel<D>(location).afterRemove(fn)
    } else {
      // all removals run across all defined models
      const [fn] = args
      const unsubs: types.Fn<[], boolean>[] =
        Array.from(new Array(this._definitions.size))

      let i = -1
      this._definitions.forEach(model => {
        unsubs[++i] = model.afterRemove(fn)
      })

      return unsubs
    }
  }
}

export { default as Model } from './model'
export * from './types'

export const connect = (path: string, options?: types.TrilogyOptions) =>
  new Trilogy(path, options)
