// Fixture: entry requires a module id the bundler does not bundle ('path').
// Proves the bundle's __require defers unknown ids to the host require.
module.exports = { sep: require('path').sep }
