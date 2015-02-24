assert = require 'assert'
a = require './a'

describe 'simple sample', ->
  it 'should export properly', () ->
    assert.equal a, 'test'
  it 'this should fail', ->
    assert.equals 1, 2

  return
