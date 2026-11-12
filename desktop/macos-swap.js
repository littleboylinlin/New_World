function run(paths) {
  ObjC.bindFunction('renamex_np', ['int', ['char *', 'char *', 'unsigned int']])
  if ($.renamex_np(paths[0], paths[1], 2) !== 0) throw new Error('The application bundles could not be exchanged')
}
