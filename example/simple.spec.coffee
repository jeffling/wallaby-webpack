assert = require 'assert'
a = require './a'

describe 'simple sample', ->
  it 'should export properly', (done) ->
    assert.equal a, 't2e'
    done()
  return
