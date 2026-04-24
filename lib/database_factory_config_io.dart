import 'dart:io';

import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void configureDatabaseFactory() {
  if (Platform.isLinux || Platform.isMacOS || Platform.isWindows) {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  }
}
