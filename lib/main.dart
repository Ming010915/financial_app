import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:intl/intl.dart';
import 'package:path/path.dart' as path;
import 'package:sqflite/sqflite.dart';

import 'database_factory_config.dart';

void main() {
  configureDatabaseFactory();
  runApp(const FinanceApp());
}

final _earliestExpenseDate = DateTime(1900);
const _defaultCurrencyCode = 'EUR';

NumberFormat _defaultCurrencyFormat() {
  return NumberFormat.simpleCurrency(name: _defaultCurrencyCode);
}

enum SummaryPeriod {
  week('Weekly'),
  month('Monthly'),
  year('Yearly');

  const SummaryPeriod(this.label);

  final String label;
}

enum SummaryChartType {
  pie('Pie'),
  line('Line');

  const SummaryChartType(this.label);

  final String label;
}

enum ExpenseCategory {
  groceries('Groceries', Icons.shopping_basket_outlined, Color(0xFF2F7D59)),
  transport('Transport', Icons.directions_car_outlined, Color(0xFF3469A6)),
  housing('Housing', Icons.home_outlined, Color(0xFF7A5C31)),
  utilities('Utilities', Icons.bolt_outlined, Color(0xFF8A6F20)),
  dining('Dining', Icons.restaurant_outlined, Color(0xFFA14D3A)),
  health('Health', Icons.medical_services_outlined, Color(0xFFB04467)),
  leisure('Leisure', Icons.sports_esports_outlined, Color(0xFF6C58A8)),
  other('Other', Icons.more_horiz, Color(0xFF5F6873));

  const ExpenseCategory(this.label, this.icon, this.color);

  final String label;
  final IconData icon;
  final Color color;
}

class ExpenseCategoryDefinition {
  const ExpenseCategoryDefinition({
    required this.id,
    required this.label,
    required this.icon,
    required this.color,
    this.isSystem = false,
  });

  final String id;
  final String label;
  final IconData icon;
  final Color color;
  final bool isSystem;

  Map<String, Object?> toJson() {
    return {'id': id, 'label': label};
  }

  factory ExpenseCategoryDefinition.fromJson(Map<String, Object?> json) {
    final id = json['id']?.toString() ?? '';
    final fallback = _categoryDefinitionForId(id);
    return ExpenseCategoryDefinition(
      id: id,
      label: json['label']?.toString().trim().isNotEmpty == true
          ? json['label'].toString().trim()
          : fallback.label,
      icon: fallback.icon,
      color: fallback.color,
      isSystem: id == _otherCategoryId,
    );
  }
}

const _otherCategoryId = 'other';

List<ExpenseCategoryDefinition> get _defaultCategoryDefinitions {
  return ExpenseCategory.values
      .map(
        (category) => ExpenseCategoryDefinition(
          id: category.name,
          label: category.label,
          icon: category.icon,
          color: category.color,
          isSystem: category == ExpenseCategory.other,
        ),
      )
      .toList();
}

ExpenseCategoryDefinition _categoryDefinitionForId(String id) {
  final matches = ExpenseCategory.values.where(
    (category) => category.name == id,
  );
  if (matches.isNotEmpty) {
    final category = matches.first;
    return ExpenseCategoryDefinition(
      id: category.name,
      label: category.label,
      icon: category.icon,
      color: category.color,
      isSystem: category == ExpenseCategory.other,
    );
  }

  final colors = [
    const Color(0xFF2F7D59),
    const Color(0xFF3469A6),
    const Color(0xFF7A5C31),
    const Color(0xFF8A6F20),
    const Color(0xFFA14D3A),
    const Color(0xFFB04467),
    const Color(0xFF6C58A8),
    const Color(0xFF5F6873),
  ];
  final hash = id.codeUnits.fold<int>(0, (value, unit) => value + unit);
  return ExpenseCategoryDefinition(
    id: id,
    label: _titleCase(id.replaceAll('_', ' ')),
    icon: Icons.label_outline,
    color: colors[hash % colors.length],
  );
}

String _titleCase(String value) {
  return value
      .trim()
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .map((part) => part[0].toUpperCase() + part.substring(1).toLowerCase())
      .join(' ');
}

class Expense {
  const Expense({
    required this.id,
    required this.title,
    required this.amount,
    required this.date,
    required this.categoryId,
    this.note = '',
    this.receiptDetails,
  });

  final String id;
  final String title;
  final double amount;
  final DateTime date;
  final String categoryId;
  final String note;
  final ReceiptDetails? receiptDetails;

  Map<String, Object?> toJson() {
    return {
      'id': id,
      'title': title,
      'amount': amount,
      'date': date.toIso8601String(),
      'categoryId': categoryId,
      'note': note,
      'receiptDetails': receiptDetails?.toJson(),
    };
  }

  factory Expense.fromJson(Map<String, Object?> json) {
    return Expense(
      id: json['id'] as String,
      title: json['title'] as String,
      amount: (json['amount'] as num).toDouble(),
      date: DateTime.parse(json['date'] as String),
      categoryId: (json['categoryId'] ?? json['category'] ?? _otherCategoryId)
          .toString(),
      note: json['note'] as String? ?? '',
      receiptDetails: json['receiptDetails'] == null
          ? null
          : ReceiptDetails.fromJson(
              Map<String, Object?>.from(json['receiptDetails'] as Map),
            ),
    );
  }
}

class FixedCost {
  const FixedCost({
    required this.id,
    required this.title,
    required this.amount,
    required this.categoryId,
    this.dayOfMonth,
    this.note = '',
  });

  final String id;
  final String title;
  final double amount;
  final String categoryId;
  final int? dayOfMonth;
  final String note;

  Map<String, Object?> toJson() {
    return {
      'id': id,
      'title': title,
      'amount': amount,
      'categoryId': categoryId,
      'dayOfMonth': dayOfMonth,
      'note': note,
    };
  }

  factory FixedCost.fromJson(Map<String, Object?> json) {
    final rawDay = json['dayOfMonth'];
    final day = rawDay is num ? rawDay.toInt() : null;
    return FixedCost(
      id: json['id'] as String,
      title: json['title'] as String,
      amount: (json['amount'] as num).toDouble(),
      categoryId: (json['categoryId'] ?? _otherCategoryId).toString(),
      dayOfMonth: day?.clamp(1, 31),
      note: json['note'] as String? ?? '',
    );
  }
}

class ReceiptDetails {
  const ReceiptDetails({
    this.merchant = '',
    this.location = '',
    this.currency = '',
    this.paymentMethod = '',
    this.subtotal,
    this.tax,
    this.tip,
    this.items = const [],
  });

  final String merchant;
  final String location;
  final String currency;
  final String paymentMethod;
  final double? subtotal;
  final double? tax;
  final double? tip;
  final List<ReceiptLineItem> items;

  bool get hasContent {
    return merchant.isNotEmpty ||
        location.isNotEmpty ||
        currency.isNotEmpty ||
        paymentMethod.isNotEmpty ||
        subtotal != null ||
        tax != null ||
        tip != null ||
        items.isNotEmpty;
  }

  Map<String, Object?> toJson() {
    final mergedItems = mergeLineItems(items);
    return {
      'merchant': merchant,
      'location': location,
      'currency': currency,
      'paymentMethod': paymentMethod,
      'subtotal': subtotal,
      'tax': tax,
      'tip': tip,
      'items': mergedItems.map((item) => item.toJson()).toList(),
    };
  }

  factory ReceiptDetails.fromJson(Map<String, Object?> json) {
    final rawItems = json['items'] is List
        ? json['items'] as List<dynamic>
        : const [];
    return ReceiptDetails(
      merchant: _readString(json, 'merchant'),
      location: _readString(json, 'location'),
      currency: _readString(json, 'currency'),
      paymentMethod: _readString(json, 'paymentMethod', 'payment_method'),
      subtotal: _readDouble(json, 'subtotal'),
      tax: _readDouble(json, 'tax'),
      tip: _readDouble(json, 'tip'),
      items: mergeLineItems(
        rawItems
            .whereType<Map>()
            .map((item) => Map<String, Object?>.from(item))
            .map(ReceiptLineItem.fromJson)
            .where((item) => item.name.isNotEmpty)
            .toList(),
      ),
    );
  }

  static List<ReceiptLineItem> mergeLineItems(List<ReceiptLineItem> items) {
    final merged = <String, ReceiptLineItem>{};
    final order = <String>[];

    for (final item in items) {
      final key = _lineItemKey(item.name);
      if (key.isEmpty) {
        continue;
      }
      final existing = merged[key];
      if (existing == null) {
        merged[key] = item;
        order.add(key);
      } else {
        final quantity = _sumNullable(existing.quantity, item.quantity);
        final totalPrice = _sumNullable(existing.totalPrice, item.totalPrice);
        merged[key] = ReceiptLineItem(
          name: existing.name,
          quantity: quantity,
          unitPrice: _mergeUnitPrice(
            existing.unitPrice,
            item.unitPrice,
            quantity,
            totalPrice,
          ),
          totalPrice: totalPrice,
        );
      }
    }

    return order.map((key) => merged[key]!).toList();
  }

  static String _lineItemKey(String name) {
    return name.trim().replaceAll(RegExp(r'\s+'), ' ').toLowerCase();
  }

  static double? _sumNullable(double? first, double? second) {
    if (first == null) {
      return second;
    }
    if (second == null) {
      return first;
    }
    return first + second;
  }

  static double? _mergeUnitPrice(
    double? first,
    double? second,
    double? quantity,
    double? totalPrice,
  ) {
    if (quantity != null && quantity > 0 && totalPrice != null) {
      return totalPrice / quantity;
    }
    if (first != null && second != null && first == second) {
      return first;
    }
    return first ?? second;
  }

  static String _readString(
    Map<String, Object?> json,
    String key, [
    String? fallbackKey,
  ]) {
    final value = json[key] ?? (fallbackKey == null ? null : json[fallbackKey]);
    return value?.toString().trim() ?? '';
  }

  static double? _readDouble(
    Map<String, Object?> json,
    String key, [
    String? fallbackKey,
  ]) {
    final value = json[key] ?? (fallbackKey == null ? null : json[fallbackKey]);
    return _parseFlexibleDouble(value);
  }

  static double? _parseFlexibleDouble(Object? value) {
    if (value == null) {
      return null;
    }
    if (value is num) {
      return value.toDouble();
    }
    final cleaned = value
        .toString()
        .replaceAll(RegExp(r'[^0-9,.\-]'), '')
        .replaceAll(',', '.');
    if (cleaned.isEmpty) {
      return null;
    }
    final lastDot = cleaned.lastIndexOf('.');
    final normalized = lastDot <= 0
        ? cleaned
        : cleaned.substring(0, lastDot).replaceAll('.', '') +
              cleaned.substring(lastDot);
    return double.tryParse(normalized);
  }
}

class ReceiptLineItem {
  const ReceiptLineItem({
    required this.name,
    this.quantity,
    this.unitPrice,
    this.totalPrice,
  });

  final String name;
  final double? quantity;
  final double? unitPrice;
  final double? totalPrice;

  Map<String, Object?> toJson() {
    return {
      'name': name,
      'quantity': quantity,
      'unitPrice': unitPrice,
      'totalPrice': totalPrice,
    };
  }

  factory ReceiptLineItem.fromJson(Map<String, Object?> json) {
    return ReceiptLineItem(
      name: ReceiptDetails._readString(json, 'name'),
      quantity: ReceiptDetails._readDouble(json, 'quantity', 'qty'),
      unitPrice: ReceiptDetails._readDouble(json, 'unitPrice', 'unit_price'),
      totalPrice: ReceiptDetails._readDouble(json, 'totalPrice', 'total_price'),
    );
  }
}

class FinanceDataSnapshot {
  const FinanceDataSnapshot({
    required this.expenses,
    required this.fixedCosts,
    required this.categories,
  });

  final List<Expense> expenses;
  final List<FixedCost> fixedCosts;
  final List<ExpenseCategoryDefinition> categories;
}

class FinanceDatabase {
  FinanceDatabase({DatabaseFactory? databaseFactory, String? databasePath})
    : _databaseFactory = databaseFactory,
      _databasePath = databasePath;

  final DatabaseFactory? _databaseFactory;
  final String? _databasePath;
  Database? _database;

  Future<FinanceDataSnapshot> load() async {
    final db = await _open();
    final expenseRows = await db.query(_expensesTable);
    final fixedCostRows = await db.query(_fixedCostsTable);
    final categoryRows = await db.query(
      _categoriesTable,
      orderBy: 'sort_order ASC, label ASC',
    );

    return FinanceDataSnapshot(
      expenses: expenseRows.map(_expenseFromRow).toList(),
      fixedCosts: fixedCostRows.map(_fixedCostFromRow).toList(),
      categories: categoryRows.map(_categoryFromRow).toList(),
    );
  }

  Future<void> saveExpenses(List<Expense> expenses) async {
    final db = await _open();
    await db.transaction((txn) async {
      await txn.delete(_expensesTable);
      for (final expense in expenses) {
        await txn.insert(
          _expensesTable,
          _expenseToRow(expense),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }

  Future<void> saveFixedCosts(List<FixedCost> fixedCosts) async {
    final db = await _open();
    await db.transaction((txn) async {
      await txn.delete(_fixedCostsTable);
      for (final fixedCost in fixedCosts) {
        await txn.insert(
          _fixedCostsTable,
          _fixedCostToRow(fixedCost),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }

  Future<void> saveCategories(
    List<ExpenseCategoryDefinition> categories,
  ) async {
    final db = await _open();
    await db.transaction((txn) async {
      await txn.delete(_categoriesTable);
      for (var index = 0; index < categories.length; index += 1) {
        await txn.insert(
          _categoriesTable,
          _categoryToRow(categories[index], index),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
    });
  }

  Future<Database> _open() async {
    final existing = _database;
    if (existing != null) {
      return existing;
    }

    final factory = _databaseFactory ?? databaseFactory;
    final dbPath =
        _databasePath ??
        path.join(await factory.getDatabasesPath(), 'personal_finance.db');
    _database = await factory.openDatabase(
      dbPath,
      options: OpenDatabaseOptions(version: 1, onCreate: _createSchema),
    );
    return _database!;
  }

  Future<void> _createSchema(Database db, int version) async {
    await db.execute('''
CREATE TABLE $_categoriesTable (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0
)
''');
    await db.execute('''
CREATE TABLE $_expensesTable (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  category_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  receipt_details TEXT
)
''');
    await db.execute('''
CREATE TABLE $_fixedCostsTable (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  amount REAL NOT NULL,
  category_id TEXT NOT NULL,
  day_of_month INTEGER,
  note TEXT NOT NULL DEFAULT ''
)
''');
  }

  static const _expensesTable = 'expenses';
  static const _fixedCostsTable = 'fixed_costs';
  static const _categoriesTable = 'expense_categories';
}

Map<String, Object?> _expenseToRow(Expense expense) {
  return {
    'id': expense.id,
    'title': expense.title,
    'amount': expense.amount,
    'date': expense.date.toIso8601String(),
    'category_id': expense.categoryId,
    'note': expense.note,
    'receipt_details': expense.receiptDetails == null
        ? null
        : jsonEncode(expense.receiptDetails!.toJson()),
  };
}

Expense _expenseFromRow(Map<String, Object?> row) {
  final receiptDetails = row['receipt_details'];
  return Expense(
    id: row['id'] as String,
    title: row['title'] as String,
    amount: (row['amount'] as num).toDouble(),
    date: DateTime.parse(row['date'] as String),
    categoryId: row['category_id'] as String,
    note: row['note'] as String? ?? '',
    receiptDetails: receiptDetails == null
        ? null
        : ReceiptDetails.fromJson(
            Map<String, Object?>.from(
              jsonDecode(receiptDetails as String) as Map,
            ),
          ),
  );
}

Map<String, Object?> _fixedCostToRow(FixedCost fixedCost) {
  return {
    'id': fixedCost.id,
    'title': fixedCost.title,
    'amount': fixedCost.amount,
    'category_id': fixedCost.categoryId,
    'day_of_month': fixedCost.dayOfMonth,
    'note': fixedCost.note,
  };
}

FixedCost _fixedCostFromRow(Map<String, Object?> row) {
  return FixedCost(
    id: row['id'] as String,
    title: row['title'] as String,
    amount: (row['amount'] as num).toDouble(),
    categoryId: row['category_id'] as String,
    dayOfMonth: row['day_of_month'] as int?,
    note: row['note'] as String? ?? '',
  );
}

Map<String, Object?> _categoryToRow(
  ExpenseCategoryDefinition category,
  int index,
) {
  return {
    'id': category.id,
    'label': category.label,
    'sort_order': index,
    'is_system': category.isSystem ? 1 : 0,
  };
}

ExpenseCategoryDefinition _categoryFromRow(Map<String, Object?> row) {
  final id = row['id'] as String;
  final fallback = _categoryDefinitionForId(id);
  return ExpenseCategoryDefinition(
    id: id,
    label: (row['label'] as String?)?.trim().isNotEmpty == true
        ? (row['label'] as String).trim()
        : fallback.label,
    icon: fallback.icon,
    color: fallback.color,
    isSystem: (row['is_system'] as int? ?? 0) == 1,
  );
}

class ExpenseStore extends ChangeNotifier {
  final List<Expense> _expenses = [];
  final List<FixedCost> _fixedCosts = [];
  final List<ExpenseCategoryDefinition> _categories = [];
  final FinanceDatabase _database;
  bool _isLoaded = false;

  ExpenseStore({FinanceDatabase? database})
    : _database = database ?? FinanceDatabase();

  bool get isLoaded => _isLoaded;

  List<ExpenseCategoryDefinition> get categories =>
      List.unmodifiable(_categories);

  List<ExpenseCategoryDefinition> get selectableCategories {
    final regular = _categories
        .where((category) => category.id != _otherCategoryId)
        .toList();
    final other = categoryForId(_otherCategoryId);
    return [...regular, other];
  }

  List<Expense> get expenses {
    final sorted = List<Expense>.from(_expenses);
    sorted.sort((a, b) => b.date.compareTo(a.date));
    return sorted;
  }

  List<FixedCost> get fixedCosts {
    final sorted = List<FixedCost>.from(_fixedCosts);
    sorted.sort((a, b) {
      final dayComparison = (a.dayOfMonth ?? 32).compareTo(b.dayOfMonth ?? 32);
      if (dayComparison != 0) {
        return dayComparison;
      }
      return a.title.toLowerCase().compareTo(b.title.toLowerCase());
    });
    return sorted;
  }

  double get totalSpent {
    return _expenses.fold<double>(
      0,
      (total, expense) => total + expense.amount,
    );
  }

  double get fixedMonthlyTotal {
    return _fixedCosts.fold<double>(
      0,
      (total, fixedCost) => total + fixedCost.amount,
    );
  }

  double get currentMonthSpent {
    final now = DateTime.now();
    final actualSpent = _expenses
        .where(
          (expense) =>
              expense.date.year == now.year && expense.date.month == now.month,
        )
        .fold<double>(0, (total, expense) => total + expense.amount);
    return actualSpent + fixedMonthlyTotal;
  }

  Map<String, double> get categoryTotals {
    final totals = <String, double>{};
    for (final expense in _expenses) {
      totals.update(
        expense.categoryId,
        (value) => value + expense.amount,
        ifAbsent: () => expense.amount,
      );
    }
    return Map.fromEntries(
      totals.entries.toList()..sort((a, b) => b.value.compareTo(a.value)),
    );
  }

  Future<void> load() async {
    final data = await _database.load();
    _categories
      ..clear()
      ..addAll(
        data.categories.isEmpty ? _defaultCategoryDefinitions : data.categories,
      );
    if (!_categories.any((category) => category.id == _otherCategoryId)) {
      _categories.add(_categoryDefinitionForId(_otherCategoryId));
    }
    if (data.categories.isEmpty) {
      await _saveCategories();
    }
    _expenses
      ..clear()
      ..addAll(data.expenses.where((expense) => expense.amount > 0));
    _fixedCosts
      ..clear()
      ..addAll(data.fixedCosts.where((fixedCost) => fixedCost.amount > 0));
    _isLoaded = true;
    notifyListeners();
  }

  ExpenseCategoryDefinition categoryForId(String id) {
    return _categories.firstWhere(
      (category) => category.id == id,
      orElse: () => _categories.firstWhere(
        (category) => category.id == _otherCategoryId,
        orElse: () => _categoryDefinitionForId(_otherCategoryId),
      ),
    );
  }

  Future<void> addCategory(String label) async {
    final normalized = label.trim();
    if (normalized.isEmpty) {
      return;
    }

    final existing = _categories.any(
      (category) => category.label.toLowerCase() == normalized.toLowerCase(),
    );
    if (existing) {
      return;
    }

    final id = _uniqueCategoryId(normalized);
    final fallback = _categoryDefinitionForId(id);
    _categories.insert(
      _categories.length - 1,
      ExpenseCategoryDefinition(
        id: id,
        label: normalized,
        icon: fallback.icon,
        color: fallback.color,
      ),
    );
    await _saveCategories();
    notifyListeners();
  }

  Future<void> updateCategory(String id, String label) async {
    if (id == _otherCategoryId) {
      return;
    }
    final normalized = label.trim();
    if (normalized.isEmpty) {
      return;
    }
    final index = _categories.indexWhere((category) => category.id == id);
    if (index == -1) {
      return;
    }
    final duplicate = _categories.any(
      (category) =>
          category.id != id &&
          category.label.toLowerCase() == normalized.toLowerCase(),
    );
    if (duplicate) {
      return;
    }
    final current = _categories[index];
    _categories[index] = ExpenseCategoryDefinition(
      id: current.id,
      label: normalized,
      icon: current.icon,
      color: current.color,
      isSystem: current.isSystem,
    );
    await _saveCategories();
    notifyListeners();
  }

  Future<void> removeCategory(String id) async {
    if (id == _otherCategoryId) {
      return;
    }
    _categories.removeWhere((category) => category.id == id);
    for (var index = 0; index < _expenses.length; index += 1) {
      final expense = _expenses[index];
      if (expense.categoryId == id) {
        _expenses[index] = Expense(
          id: expense.id,
          title: expense.title,
          amount: expense.amount,
          date: expense.date,
          categoryId: _otherCategoryId,
          note: expense.note,
          receiptDetails: expense.receiptDetails,
        );
      }
    }
    for (var index = 0; index < _fixedCosts.length; index += 1) {
      final fixedCost = _fixedCosts[index];
      if (fixedCost.categoryId == id) {
        _fixedCosts[index] = FixedCost(
          id: fixedCost.id,
          title: fixedCost.title,
          amount: fixedCost.amount,
          categoryId: _otherCategoryId,
          dayOfMonth: fixedCost.dayOfMonth,
          note: fixedCost.note,
        );
      }
    }
    await _saveCategories();
    await _save();
    await _saveFixedCosts();
    notifyListeners();
  }

  Future<void> addExpense(Expense expense) async {
    _expenses.add(expense);
    await _save();
    notifyListeners();
  }

  Future<void> updateExpense(Expense expense) async {
    final index = _expenses.indexWhere((item) => item.id == expense.id);
    if (index == -1) {
      _expenses.add(expense);
    } else {
      _expenses[index] = expense;
    }
    await _save();
    notifyListeners();
  }

  Future<void> removeExpense(String id) async {
    _expenses.removeWhere((expense) => expense.id == id);
    await _save();
    notifyListeners();
  }

  Future<void> addFixedCost(FixedCost fixedCost) async {
    _fixedCosts.add(fixedCost);
    await _saveFixedCosts();
    notifyListeners();
  }

  Future<void> updateFixedCost(FixedCost fixedCost) async {
    final index = _fixedCosts.indexWhere((item) => item.id == fixedCost.id);
    if (index == -1) {
      _fixedCosts.add(fixedCost);
    } else {
      _fixedCosts[index] = fixedCost;
    }
    await _saveFixedCosts();
    notifyListeners();
  }

  Future<void> removeFixedCost(String id) async {
    _fixedCosts.removeWhere((fixedCost) => fixedCost.id == id);
    await _saveFixedCosts();
    notifyListeners();
  }

  Future<void> _save() async {
    await _database.saveExpenses(_expenses);
  }

  Future<void> _saveFixedCosts() async {
    await _database.saveFixedCosts(_fixedCosts);
  }

  Future<void> _saveCategories() async {
    await _database.saveCategories(_categories);
  }

  String _uniqueCategoryId(String label) {
    final base = label
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9]+'), '_')
        .replaceAll(RegExp(r'^_+|_+$'), '');
    final normalizedBase = base.isEmpty ? 'category' : base;
    var candidate = normalizedBase;
    var suffix = 2;
    while (_categories.any((category) => category.id == candidate)) {
      candidate = '${normalizedBase}_$suffix';
      suffix += 1;
    }
    return candidate;
  }
}

class ReceiptAiService {
  ReceiptAiService({http.Client? client}) : _client = client ?? http.Client();

  static const _apiKey = String.fromEnvironment('GOOGLE_AI_API_KEY');
  static const _model = String.fromEnvironment(
    'GOOGLE_AI_MODEL',
    defaultValue: 'gemini-3-flash-preview',
  );

  final http.Client _client;

  bool get isConfigured => _apiKey.isNotEmpty;

  Future<String> summarizeSpending({
    required List<Expense> expenses,
    required List<ExpenseCategoryDefinition> categories,
    required SummaryPeriod period,
  }) async {
    if (!isConfigured) {
      throw const ReceiptAiException(
        'Add a Google AI Studio key with --dart-define=GOOGLE_AI_API_KEY=your_key',
      );
    }
    if (expenses.isEmpty) {
      throw const ReceiptAiException(
        'Add expenses before generating a summary.',
      );
    }

    final uri = Uri.https(
      'generativelanguage.googleapis.com',
      '/v1beta/models/$_model:generateContent',
    );
    final categoryById = {
      for (final category in categories) category.id: category.label,
      _otherCategoryId: _categoryDefinitionForId(_otherCategoryId).label,
    };
    final totals = <String, double>{};
    for (final expense in expenses) {
      totals.update(
        expense.categoryId,
        (value) => value + expense.amount,
        ifAbsent: () => expense.amount,
      );
    }
    final sortedExpenses = List<Expense>.from(expenses)
      ..sort((a, b) => b.date.compareTo(a.date));
    final history = sortedExpenses.take(80).map((expense) {
      return {
        'date': DateFormat('yyyy-MM-dd').format(expense.date),
        'title': expense.title,
        'amount': expense.amount,
        'category':
            categoryById[expense.categoryId] ??
            _categoryDefinitionForId(expense.categoryId).label,
        if (expense.note.trim().isNotEmpty) 'note': expense.note.trim(),
      };
    }).toList();
    final categoryTotals = totals.entries.toList()
      ..sort((a, b) => b.value.compareTo(a.value));

    final response = await _client.post(
      uri,
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': _apiKey},
      body: jsonEncode({
        'contents': [
          {
            'parts': [
              {
                'text':
                    '''
You are a personal finance assistant. Summarize this user's ${period.label.toLowerCase()} expense history in natural language.
Be specific about where the money went, mention the largest categories or purchases, and suggest one or two practical spending adjustments.
Use a friendly, concise tone. Do not invent income, budgets, account balances, or financial advice beyond the expense data.
Return 2 short paragraphs, no markdown bullets.

Expense history:
${jsonEncode({
                      'period': period.label,
                      'transactionCount': expenses.length,
                      'totalSpent': expenses.fold<double>(0, (sum, item) => sum + item.amount),
                      'categoryTotals': categoryTotals.map((entry) => {'category': categoryById[entry.key] ?? _categoryDefinitionForId(entry.key).label, 'amount': entry.value}).toList(),
                      'transactions': history,
                    })}
''',
              },
            ],
          },
        ],
        'generationConfig': {'temperature': 0.4},
      }),
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ReceiptAiException(
        'Gemini request failed (${response.statusCode}). ${_extractError(response.body)}',
      );
    }

    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    final text = _responseText(decoded)?.trim();
    if (text == null || text.isEmpty) {
      throw const ReceiptAiException('Gemini did not return a summary.');
    }
    return text;
  }

  Future<Expense> extractExpense({
    required Uint8List bytes,
    required String mimeType,
    required String fileName,
    required List<ExpenseCategoryDefinition> categories,
  }) async {
    if (!isConfigured) {
      throw const ReceiptAiException(
        'Add a Google AI Studio key with --dart-define=GOOGLE_AI_API_KEY=your_key',
      );
    }

    final uri = Uri.https(
      'generativelanguage.googleapis.com',
      '/v1beta/models/$_model:generateContent',
    );
    final allowedCategories = _categoryPromptList(categories);

    final response = await _client.post(
      uri,
      headers: {'Content-Type': 'application/json', 'x-goog-api-key': _apiKey},
      body: jsonEncode({
        'contents': [
          {
            'parts': [
              {
                'text':
                    '''
Decide whether this upload is a clear receipt, invoice, or purchase document, then extract one expense only when it is valid.
Return only valid JSON.
If the upload is not a purchase receipt/invoice/document, is too blurry, is cropped so the merchant/total cannot be read, or does not contain enough purchase information, return exactly:
{"isValidReceipt":false,"reuploadReason":"short reason asking the user to upload a clearer receipt"}
For a valid upload, return this exact schema:
{"isValidReceipt":true,"title":"merchant or concise purchase title","amount":12.34,"date":"YYYY-MM-DD","categoryId":"one allowed category id","note":"brief useful receipt details","receiptDetails":{"merchant":"store or seller name","location":"store address, city, or location if visible","currency":"ISO currency code or symbol","paymentMethod":"cash, card, online, or empty string","subtotal":10.00,"tax":1.23,"tip":0.00,"items":[{"name":"item name","quantity":1,"unitPrice":2.50,"totalPrice":2.50}]}}
Choose categoryId only from this fixed user category list:
$allowedCategories
If none of the listed categories fit, use "$_otherCategoryId".
Use the final charged total as amount. If the date is missing, use today's date ${DateFormat('yyyy-MM-dd').format(DateTime.now())}.
Use null for unknown numeric fields, an empty string for unknown text fields, and an empty array when no item lines are visible.
Do not invent expense fields for invalid uploads.
''',
              },
              {
                'inline_data': {
                  'mime_type': mimeType,
                  'data': base64Encode(bytes),
                },
              },
            ],
          },
        ],
        'generationConfig': {
          'responseMimeType': 'application/json',
          'temperature': 0.1,
        },
      }),
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ReceiptAiException(
        'Gemini request failed (${response.statusCode}). ${_extractError(response.body)}',
      );
    }

    final decoded = jsonDecode(response.body) as Map<String, dynamic>;
    final text = _responseText(decoded);
    debugPrint('Gemini raw response: ${response.body}');
    debugPrint('Gemini extracted JSON: $text');

    if (text == null || text.trim().isEmpty) {
      throw const ReceiptAiException('Gemini did not return receipt details.');
    }

    return _expenseFromAiJson(text, fileName, categories);
  }

  static String _categoryPromptList(
    List<ExpenseCategoryDefinition> categories,
  ) {
    final unique = <String, ExpenseCategoryDefinition>{};
    for (final category in categories) {
      unique[category.id] = category;
    }
    unique[_otherCategoryId] = _categoryDefinitionForId(_otherCategoryId);
    return unique.values
        .map((category) => '- ${category.id}: ${category.label}')
        .join('\n');
  }

  static String? _responseText(Map<String, dynamic> decoded) {
    final candidates = decoded['candidates'] as List<dynamic>?;
    if (candidates == null || candidates.isEmpty) {
      return null;
    }
    final content = candidates.first['content'] as Map<String, dynamic>?;
    final parts = content?['parts'] as List<dynamic>?;
    if (parts == null || parts.isEmpty) {
      return null;
    }
    return parts
        .map((part) => (part as Map<String, dynamic>)['text'] as String? ?? '')
        .join();
  }

  static String _extractError(String body) {
    try {
      final decoded = jsonDecode(body) as Map<String, dynamic>;
      final error = decoded['error'] as Map<String, dynamic>?;
      return error?['message'] as String? ?? body;
    } catch (_) {
      return body;
    }
  }

  static Expense _expenseFromAiJson(
    String rawJson,
    String fileName,
    List<ExpenseCategoryDefinition> categories,
  ) {
    final cleaned = rawJson
        .trim()
        .replaceFirst(RegExp(r'^```json\s*'), '')
        .replaceFirst(RegExp(r'^```\s*'), '')
        .replaceFirst(RegExp(r'\s*```$'), '');
    final decoded = _decodeJsonObject(cleaned);
    final isValidReceipt = decoded['isValidReceipt'];
    if (isValidReceipt == false) {
      final reason = ReceiptDetails._readString(decoded, 'reuploadReason');
      throw ReceiptAiException(
        reason.isEmpty
            ? 'This does not look like a clear receipt. Please upload a clearer receipt image or file.'
            : reason,
      );
    }

    final amount = ReceiptDetails._readDouble(decoded, 'amount', 'total') ?? 0;
    if (amount <= 0) {
      throw const ReceiptAiException(
        'Could not read a valid receipt total. Please upload a clearer receipt.',
      );
    }

    final title = ReceiptDetails._readString(decoded, 'title');
    final categoryId = _readAllowedCategoryId(decoded, categories);

    final rawDate = ReceiptDetails._readString(decoded, 'date');
    final parsedDate = rawDate.isEmpty ? null : DateTime.tryParse(rawDate);
    final receiptDetails =
        decoded['receiptDetails'] ?? decoded['receipt_details'];

    return Expense(
      id: DateTime.now().microsecondsSinceEpoch.toString(),
      title: title.isEmpty ? fileName : title,
      amount: amount,
      date: parsedDate ?? DateTime.now(),
      categoryId: categoryId,
      note: ReceiptDetails._readString(decoded, 'note'),
      receiptDetails: receiptDetails == null || receiptDetails is! Map
          ? null
          : ReceiptDetails.fromJson(Map<String, Object?>.from(receiptDetails)),
    );
  }

  static String _readAllowedCategoryId(
    Map<String, Object?> decoded,
    List<ExpenseCategoryDefinition> categories,
  ) {
    final allowed = <String, ExpenseCategoryDefinition>{
      for (final category in categories) category.id: category,
      _otherCategoryId: _categoryDefinitionForId(_otherCategoryId),
    };
    final raw = ReceiptDetails._readString(
      decoded,
      'categoryId',
      'category_id',
    );
    final legacyRaw = raw.isEmpty
        ? ReceiptDetails._readString(decoded, 'category')
        : raw;
    final normalized = legacyRaw.toLowerCase().trim();
    if (allowed.containsKey(normalized)) {
      return normalized;
    }
    for (final category in allowed.values) {
      if (category.label.toLowerCase() == normalized) {
        return category.id;
      }
    }
    return _otherCategoryId;
  }

  static Map<String, Object?> _decodeJsonObject(String cleaned) {
    final decoded = jsonDecode(cleaned);
    if (decoded is Map) {
      return Map<String, Object?>.from(decoded);
    }
    if (decoded is List && decoded.isNotEmpty && decoded.first is Map) {
      return Map<String, Object?>.from(decoded.first as Map);
    }
    throw const ReceiptAiException(
      'Gemini returned JSON in an unsupported shape.',
    );
  }
}

class ReceiptAiException implements Exception {
  const ReceiptAiException(this.message);

  final String message;

  @override
  String toString() => message;
}

class FinanceApp extends StatefulWidget {
  const FinanceApp({super.key});

  @override
  State<FinanceApp> createState() => _FinanceAppState();
}

class _FinanceAppState extends State<FinanceApp> {
  final ExpenseStore _store = ExpenseStore();

  @override
  void initState() {
    super.initState();
    _store.load();
  }

  @override
  void dispose() {
    _store.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Finance Tracker',
      theme: _buildTheme(),
      themeMode: ThemeMode.dark,
      home: ExpenseHomePage(store: _store),
    );
  }

  ThemeData _buildTheme() {
    const background = Color(0xFF0F1110);
    const surface = Color(0xFF171918);
    const primary = Color(0xFF8ECDB0);
    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: primary,
          brightness: Brightness.dark,
        ).copyWith(
          primary: primary,
          surface: surface,
          surfaceContainerHighest: const Color(0xFF202321),
          outline: const Color(0xFF5E6761),
          outlineVariant: const Color(0xFF2B302C),
        );

    final inputBorder = OutlineInputBorder(
      borderRadius: BorderRadius.circular(8),
      borderSide: BorderSide(color: colorScheme.outlineVariant),
    );

    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: background,
      dividerColor: colorScheme.outlineVariant,
      appBarTheme: const AppBarTheme(
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        backgroundColor: background,
        foregroundColor: Color(0xFFE7EEE9),
      ),
      bottomSheetTheme: const BottomSheetThemeData(
        showDragHandle: true,
        backgroundColor: surface,
        modalBackgroundColor: surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(8)),
        ),
      ),
      floatingActionButtonTheme: FloatingActionButtonThemeData(
        backgroundColor: colorScheme.primary,
        foregroundColor: colorScheme.onPrimary,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: colorScheme.onSurface,
          side: BorderSide(color: colorScheme.outlineVariant),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(
          foregroundColor: colorScheme.onSurfaceVariant,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        border: inputBorder,
        enabledBorder: inputBorder,
        focusedBorder: inputBorder.copyWith(
          borderSide: BorderSide(color: colorScheme.primary),
        ),
      ),
      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      ),
    );
  }
}

class ExpenseHomePage extends StatelessWidget {
  ExpenseHomePage({super.key, required this.store});

  final ExpenseStore store;
  final ReceiptAiService _receiptAiService = ReceiptAiService();

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: store,
      builder: (context, _) {
        return Scaffold(
          appBar: AppBar(
            title: const Text('Expenses'),
            actions: [
              IconButton(
                tooltip: 'Summaries',
                onPressed: () => _showSummariesPage(context),
                icon: const Icon(Icons.insert_chart_outlined),
              ),
              IconButton(
                tooltip: 'Categories',
                onPressed: () => _showCategoriesPage(context),
                icon: const Icon(Icons.category_outlined),
              ),
              IconButton(
                tooltip: 'Scan receipt',
                onPressed: () => _showReceiptImportSheet(context),
                icon: const Icon(Icons.document_scanner_outlined),
              ),
              IconButton(
                tooltip: 'Add expense',
                onPressed: () => _showAddExpenseSheet(context),
                icon: const Icon(Icons.add),
              ),
            ],
          ),
          body: store.isLoaded
              ? _ExpenseDashboard(store: store)
              : const Center(child: CircularProgressIndicator()),
          floatingActionButton: FloatingActionButton.extended(
            onPressed: () => _showReceiptImportSheet(context),
            icon: const Icon(Icons.document_scanner_outlined),
            label: const Text('Receipt'),
          ),
        );
      },
    );
  }

  void _showAddExpenseSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => AddExpenseSheet(store: store),
    );
  }

  void _showReceiptImportSheet(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      builder: (context) =>
          ReceiptImportSheet(store: store, receiptAiService: _receiptAiService),
    );
  }

  Future<void> _showCategoriesPage(BuildContext context) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (context) => CategoriesPage(store: store)),
    );
  }

  Future<void> _showSummariesPage(BuildContext context) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(
        builder: (context) => CategorySummariesPage(store: store),
      ),
    );
  }
}

class CategorySummariesPage extends StatefulWidget {
  const CategorySummariesPage({super.key, required this.store});

  final ExpenseStore store;

  @override
  State<CategorySummariesPage> createState() => _CategorySummariesPageState();
}

class _CategorySummariesPageState extends State<CategorySummariesPage> {
  final ReceiptAiService _receiptAiService = ReceiptAiService();
  SummaryPeriod _period = SummaryPeriod.week;
  SummaryChartType _chartType = SummaryChartType.pie;
  bool _isGeneratingInsight = false;
  String? _spendingInsight;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.store,
      builder: (context, _) {
        final expenses = _expensesForPeriod(widget.store.expenses, _period);
        final insightExpenses = [
          ...expenses,
          ..._fixedCostsAsExpenses(widget.store.fixedCosts, _period),
        ];
        final totals = _categoryTotals(
          expenses,
          widget.store.fixedCosts,
          _period,
        );
        final totalSpent = totals.values.fold<double>(
          0,
          (total, amount) => total + amount,
        );
        final fixedCostCount = _fixedCostCountForPeriod(
          widget.store.fixedCosts,
          _period,
        );
        final currency = _defaultCurrencyFormat();

        return Scaffold(
          appBar: AppBar(title: const Text('Summaries')),
          body: SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                SegmentedButton<SummaryPeriod>(
                  segments: SummaryPeriod.values
                      .map(
                        (period) => ButtonSegment(
                          value: period,
                          label: Text(period.label),
                        ),
                      )
                      .toList(),
                  selected: {_period},
                  onSelectionChanged: (selected) {
                    setState(() {
                      _period = selected.single;
                      _spendingInsight = null;
                    });
                  },
                ),
                const SizedBox(height: 10),
                SegmentedButton<SummaryChartType>(
                  segments: SummaryChartType.values
                      .map(
                        (chartType) => ButtonSegment(
                          value: chartType,
                          icon: Icon(
                            chartType == SummaryChartType.pie
                                ? Icons.pie_chart_outline
                                : Icons.show_chart,
                          ),
                          label: Text(chartType.label),
                        ),
                      )
                      .toList(),
                  selected: {_chartType},
                  onSelectionChanged: (selected) {
                    setState(() => _chartType = selected.single);
                  },
                ),
                const SizedBox(height: 16),
                _SummaryRangeHeader(
                  period: _period,
                  total: totalSpent,
                  itemCount: expenses.length + fixedCostCount,
                  currency: currency,
                ),
                const SizedBox(height: 12),
                _AiSpendingInsightCard(
                  summary: _spendingInsight,
                  isLoading: _isGeneratingInsight,
                  isEnabled: insightExpenses.isNotEmpty,
                  onGenerate: () => _generateSpendingInsight(insightExpenses),
                ),
                const SizedBox(height: 20),
                if (totals.isEmpty)
                  const _SummaryEmptyState()
                else ...[
                  Text(
                    _chartType == SummaryChartType.line
                        ? 'Category trends'
                        : 'Category split',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 12),
                  if (_chartType == SummaryChartType.line)
                    _CategoryLineChart(
                      expenses: expenses,
                      fixedCosts: widget.store.fixedCosts,
                      totals: totals,
                      categories: widget.store.categories,
                      period: _period,
                    )
                  else
                    _CategoryPieChart(
                      totals: totals,
                      categories: widget.store.categories,
                    ),
                  const SizedBox(height: 20),
                  Text(
                    'Category totals',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 8),
                  _SummaryCategoryTotals(
                    totals: totals,
                    totalSpent: totalSpent,
                    store: widget.store,
                    currency: currency,
                  ),
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _generateSpendingInsight(List<Expense> expenses) async {
    setState(() {
      _isGeneratingInsight = true;
      _spendingInsight = null;
    });

    try {
      final summary = await _receiptAiService.summarizeSpending(
        expenses: expenses,
        categories: widget.store.categories,
        period: _period,
      );
      if (!mounted) {
        return;
      }
      setState(() => _spendingInsight = summary);
    } on ReceiptAiException catch (error) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(error.message)));
    } catch (_) {
      if (!mounted) {
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Could not generate spending summary.')),
      );
    } finally {
      if (mounted) {
        setState(() => _isGeneratingInsight = false);
      }
    }
  }

  List<Expense> _expensesForPeriod(
    List<Expense> expenses,
    SummaryPeriod period,
  ) {
    final range = _rangeForPeriod(period);
    final start = range.start;
    final end = range.end;

    return expenses.where((expense) {
      final date = DateTime(
        expense.date.year,
        expense.date.month,
        expense.date.day,
      );
      return !date.isBefore(start) && date.isBefore(end);
    }).toList();
  }

  _SummaryDateRange _rangeForPeriod(SummaryPeriod period) {
    final now = DateTime.now();
    final start = switch (period) {
      SummaryPeriod.week => DateTime(
        now.year,
        now.month,
        now.day - now.weekday + 1,
      ),
      SummaryPeriod.month => DateTime(now.year, now.month),
      SummaryPeriod.year => DateTime(now.year),
    };
    final end = switch (period) {
      SummaryPeriod.week => start.add(const Duration(days: 7)),
      SummaryPeriod.month => DateTime(now.year, now.month + 1),
      SummaryPeriod.year => DateTime(now.year + 1),
    };

    return _SummaryDateRange(start: start, end: end);
  }

  Map<String, double> _categoryTotals(
    List<Expense> expenses,
    List<FixedCost> fixedCosts,
    SummaryPeriod period,
  ) {
    final totals = <String, double>{};
    for (final expense in expenses) {
      totals.update(
        expense.categoryId,
        (value) => value + expense.amount,
        ifAbsent: () => expense.amount,
      );
    }
    for (final fixedCost in fixedCosts) {
      final multiplier = _fixedCostMultiplierForPeriod(fixedCost, period);
      if (multiplier == 0) {
        continue;
      }
      final amount = fixedCost.amount * multiplier;
      totals.update(
        fixedCost.categoryId,
        (value) => value + amount,
        ifAbsent: () => amount,
      );
    }
    return Map.fromEntries(
      totals.entries.toList()..sort((a, b) => b.value.compareTo(a.value)),
    );
  }

  int _fixedCostCountForPeriod(
    List<FixedCost> fixedCosts,
    SummaryPeriod period,
  ) {
    return fixedCosts.fold<int>(
      0,
      (count, fixedCost) =>
          count + _fixedCostMultiplierForPeriod(fixedCost, period),
    );
  }

  int _fixedCostMultiplierForPeriod(FixedCost fixedCost, SummaryPeriod period) {
    switch (period) {
      case SummaryPeriod.week:
        return _fixedCostOccurrencesInRange(
          fixedCost,
          _rangeForPeriod(period),
        ).length;
      case SummaryPeriod.month:
        return 1;
      case SummaryPeriod.year:
        return 12;
    }
  }

  List<Expense> _fixedCostsAsExpenses(
    List<FixedCost> fixedCosts,
    SummaryPeriod period,
  ) {
    return fixedCosts.expand((fixedCost) {
      final dates = _fixedCostDatesForPeriod(fixedCost, period);
      return dates.map(
        (date) => Expense(
          id: 'fixed-${fixedCost.id}-${date.toIso8601String()}',
          title: fixedCost.title,
          amount: fixedCost.amount,
          date: date,
          categoryId: fixedCost.categoryId,
          note: fixedCost.note.isEmpty ? 'Fixed monthly cost' : fixedCost.note,
        ),
      );
    }).toList();
  }

  List<DateTime> _fixedCostDatesForPeriod(
    FixedCost fixedCost,
    SummaryPeriod period,
  ) {
    final range = _rangeForPeriod(period);
    switch (period) {
      case SummaryPeriod.week:
        return _fixedCostOccurrencesInRange(fixedCost, range);
      case SummaryPeriod.month:
        return [_fixedCostDateInMonth(fixedCost, range.start)];
      case SummaryPeriod.year:
        return List.generate(
          12,
          (index) => _fixedCostDateInMonth(
            fixedCost,
            DateTime(range.start.year, index + 1),
          ),
        );
    }
  }

  DateTime _fixedCostDateInMonth(FixedCost fixedCost, DateTime month) {
    final monthLength = DateTime(month.year, month.month + 1, 0).day;
    final day = (fixedCost.dayOfMonth ?? 1).clamp(1, monthLength);
    return DateTime(month.year, month.month, day);
  }

  List<DateTime> _fixedCostOccurrencesInRange(
    FixedCost fixedCost,
    _SummaryDateRange range,
  ) {
    final dayOfMonth = fixedCost.dayOfMonth;
    if (dayOfMonth == null) {
      return const [];
    }

    final occurrences = <DateTime>[];
    var cursor = DateTime(range.start.year, range.start.month);
    final endMonth = DateTime(range.end.year, range.end.month);
    while (!cursor.isAfter(endMonth)) {
      final day = dayOfMonth.clamp(
        1,
        DateTime(cursor.year, cursor.month + 1, 0).day,
      );
      final occurrence = DateTime(cursor.year, cursor.month, day);
      if (!occurrence.isBefore(range.start) && occurrence.isBefore(range.end)) {
        occurrences.add(occurrence);
      }
      cursor = DateTime(cursor.year, cursor.month + 1);
    }
    return occurrences;
  }
}

class _SummaryDateRange {
  const _SummaryDateRange({required this.start, required this.end});

  final DateTime start;
  final DateTime end;
}

class _AiSpendingInsightCard extends StatelessWidget {
  const _AiSpendingInsightCard({
    required this.summary,
    required this.isLoading,
    required this.isEnabled,
    required this.onGenerate,
  });

  final String? summary;
  final bool isLoading;
  final bool isEnabled;
  final VoidCallback onGenerate;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: colorScheme.surface,
        border: Border.all(color: colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.auto_awesome_outlined, color: colorScheme.primary),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  'AI spending insight',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ),
              IconButton(
                tooltip: 'Generate spending insight',
                onPressed: isLoading || !isEnabled ? null : onGenerate,
                icon: isLoading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            summary ??
                (isEnabled
                    ? 'Generate a natural-language summary of this period.'
                    : 'Add expenses to generate a spending summary.'),
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(
              color: summary == null
                  ? colorScheme.onSurfaceVariant
                  : colorScheme.onSurface,
            ),
          ),
        ],
      ),
    );
  }
}

class _SummaryRangeHeader extends StatelessWidget {
  const _SummaryRangeHeader({
    required this.period,
    required this.total,
    required this.itemCount,
    required this.currency,
  });

  final SummaryPeriod period;
  final double total;
  final int itemCount;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: _SummaryMetric(
              label: '${period.label} total',
              value: currency.format(total),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: _SummaryMetric(label: 'Items', value: itemCount.toString()),
          ),
        ],
      ),
    );
  }
}

class _CategoryPieChart extends StatelessWidget {
  const _CategoryPieChart({required this.totals, required this.categories});

  final Map<String, double> totals;
  final List<ExpenseCategoryDefinition> categories;

  @override
  Widget build(BuildContext context) {
    final slices = totals.entries
        .map((entry) => _ChartValue(_categoryForId(entry.key), entry.value))
        .toList();

    return Column(
      children: [
        SizedBox(
          height: 240,
          width: double.infinity,
          child: CustomPaint(painter: _PieChartPainter(slices)),
        ),
        const SizedBox(height: 12),
        _ChartLegend(values: slices),
      ],
    );
  }

  ExpenseCategoryDefinition _categoryForId(String id) {
    return categories.firstWhere(
      (category) => category.id == id,
      orElse: () => _categoryDefinitionForId(id),
    );
  }
}

class _CategoryLineChart extends StatelessWidget {
  const _CategoryLineChart({
    required this.expenses,
    required this.fixedCosts,
    required this.totals,
    required this.categories,
    required this.period,
  });

  final List<Expense> expenses;
  final List<FixedCost> fixedCosts;
  final Map<String, double> totals;
  final List<ExpenseCategoryDefinition> categories;
  final SummaryPeriod period;

  @override
  Widget build(BuildContext context) {
    final bucketCount = _bucketCount();
    final series = totals.keys.map((categoryId) {
      final category = _categoryForId(categoryId);
      final values = List<double>.filled(bucketCount, 0);
      for (final expense in expenses) {
        if (expense.categoryId == categoryId) {
          values[_bucketIndex(expense)] += expense.amount;
        }
      }
      for (final fixedCost in fixedCosts) {
        if (fixedCost.categoryId == categoryId) {
          for (final index in _fixedCostBucketIndexes(fixedCost)) {
            values[index] += fixedCost.amount;
          }
        }
      }
      return _LineChartSeries(category: category, values: values);
    }).toList();

    return Column(
      children: [
        Container(
          height: 260,
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(6, 8, 8, 0),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: CustomPaint(
            painter: _LineChartPainter(
              series: series,
              endLabel: _endLabel(bucketCount),
              axisColor: Theme.of(context).colorScheme.outlineVariant,
              labelColor: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ),
        const SizedBox(height: 12),
        _ChartLegend(
          values: series
              .map(
                (item) => _ChartValue(
                  item.category,
                  item.values.fold<double>(0, (total, value) => total + value),
                ),
              )
              .toList(),
        ),
      ],
    );
  }

  int _bucketCount() {
    final now = DateTime.now();
    return switch (period) {
      SummaryPeriod.week => 7,
      SummaryPeriod.month => DateTime(now.year, now.month + 1, 0).day,
      SummaryPeriod.year => 12,
    };
  }

  int _bucketIndex(Expense expense) {
    return switch (period) {
      SummaryPeriod.week => expense.date.weekday - 1,
      SummaryPeriod.month => expense.date.day - 1,
      SummaryPeriod.year => expense.date.month - 1,
    };
  }

  List<int> _fixedCostBucketIndexes(FixedCost fixedCost) {
    return switch (period) {
      SummaryPeriod.week => _fixedCostWeeklyBuckets(fixedCost),
      SummaryPeriod.month => [_fixedCostMonthlyBucket(fixedCost)],
      SummaryPeriod.year => List.generate(12, (index) => index),
    };
  }

  List<int> _fixedCostWeeklyBuckets(FixedCost fixedCost) {
    final dayOfMonth = fixedCost.dayOfMonth;
    if (dayOfMonth == null) {
      return const [];
    }
    final now = DateTime.now();
    final start = DateTime(now.year, now.month, now.day - now.weekday + 1);
    final end = start.add(const Duration(days: 7));
    final buckets = <int>[];
    var cursor = DateTime(start.year, start.month);
    final endMonth = DateTime(end.year, end.month);
    while (!cursor.isAfter(endMonth)) {
      final day = dayOfMonth.clamp(
        1,
        DateTime(cursor.year, cursor.month + 1, 0).day,
      );
      final occurrence = DateTime(cursor.year, cursor.month, day);
      if (!occurrence.isBefore(start) && occurrence.isBefore(end)) {
        buckets.add(occurrence.weekday - 1);
      }
      cursor = DateTime(cursor.year, cursor.month + 1);
    }
    return buckets;
  }

  int _fixedCostMonthlyBucket(FixedCost fixedCost) {
    final now = DateTime.now();
    final monthLength = DateTime(now.year, now.month + 1, 0).day;
    return (fixedCost.dayOfMonth ?? 1).clamp(1, monthLength) - 1;
  }

  String _endLabel(int bucketCount) {
    return switch (period) {
      SummaryPeriod.week => '7',
      SummaryPeriod.month => bucketCount.toString(),
      SummaryPeriod.year => '12',
    };
  }

  ExpenseCategoryDefinition _categoryForId(String id) {
    return categories.firstWhere(
      (category) => category.id == id,
      orElse: () => _categoryDefinitionForId(id),
    );
  }
}

class _SummaryCategoryTotals extends StatelessWidget {
  const _SummaryCategoryTotals({
    required this.totals,
    required this.totalSpent,
    required this.store,
    required this.currency,
  });

  final Map<String, double> totals;
  final double totalSpent;
  final ExpenseStore store;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: totals.entries.map((entry) {
        final category = store.categoryForId(entry.key);
        final percent = totalSpent == 0 ? 0.0 : entry.value / totalSpent;
        return Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Row(
            children: [
              Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: category.color,
                  borderRadius: BorderRadius.circular(3),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(child: Text(category.label)),
              const SizedBox(width: 10),
              Text('${(percent * 100).round()}%'),
              const SizedBox(width: 12),
              Text(currency.format(entry.value)),
            ],
          ),
        );
      }).toList(),
    );
  }
}

class _ChartLegend extends StatelessWidget {
  const _ChartLegend({required this.values});

  final List<_ChartValue> values;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 12,
      runSpacing: 8,
      children: values.map((value) {
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: value.category.color,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
            Text(
              value.category.label,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        );
      }).toList(),
    );
  }
}

class _SummaryEmptyState extends StatelessWidget {
  const _SummaryEmptyState();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 56),
      child: Column(
        children: [
          Icon(
            Icons.pie_chart_outline,
            size: 56,
            color: Theme.of(context).colorScheme.outline,
          ),
          const SizedBox(height: 12),
          Text(
            'No expenses in this period',
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}

class _ChartValue {
  const _ChartValue(this.category, this.amount);

  final ExpenseCategoryDefinition category;
  final double amount;
}

class _LineChartSeries {
  const _LineChartSeries({required this.category, required this.values});

  final ExpenseCategoryDefinition category;
  final List<double> values;
}

class _PieChartPainter extends CustomPainter {
  const _PieChartPainter(this.values);

  final List<_ChartValue> values;

  @override
  void paint(Canvas canvas, Size size) {
    final total = values.fold<double>(0, (sum, value) => sum + value.amount);
    if (total <= 0) {
      return;
    }

    final radius = size.shortestSide * 0.42;
    final center = Offset(size.width / 2, size.height / 2);
    final rect = Rect.fromCircle(center: center, radius: radius);
    final paint = Paint()..style = PaintingStyle.fill;
    var startAngle = -1.5708;

    for (final value in values) {
      final sweep = (value.amount / total) * 6.283185307179586;
      paint.color = value.category.color;
      canvas.drawArc(rect, startAngle, sweep, true, paint);
      startAngle += sweep;
    }

    paint
      ..color = const Color(0xFF0F1110)
      ..style = PaintingStyle.fill;
    canvas.drawCircle(center, radius * 0.48, paint);
  }

  @override
  bool shouldRepaint(covariant _PieChartPainter oldDelegate) {
    return oldDelegate.values != values;
  }
}

class _LineChartPainter extends CustomPainter {
  const _LineChartPainter({
    required this.series,
    required this.endLabel,
    required this.axisColor,
    required this.labelColor,
  });

  final List<_LineChartSeries> series;
  final String endLabel;
  final Color axisColor;
  final Color labelColor;

  @override
  void paint(Canvas canvas, Size size) {
    if (series.isEmpty) {
      return;
    }

    const leftPadding = 44.0;
    const rightPadding = 10.0;
    const topPadding = 14.0;
    const bottomPadding = 34.0;
    final chart = Rect.fromLTWH(
      leftPadding,
      topPadding,
      size.width - leftPadding - rightPadding,
      size.height - topPadding - bottomPadding,
    );
    final maxValue = series
        .expand((item) => item.values)
        .fold<double>(0, (max, value) => value > max ? value : max);
    final scaleMax = maxValue <= 0 ? 1.0 : maxValue;
    final axisPaint = Paint()
      ..color = axisColor
      ..strokeWidth = 1;

    for (var index = 0; index <= 4; index += 1) {
      final y = chart.bottom - chart.height * (index / 4);
      canvas.drawLine(Offset(chart.left, y), Offset(chart.right, y), axisPaint);
    }
    canvas.drawLine(
      Offset(chart.left, chart.top),
      Offset(chart.left, chart.bottom),
      axisPaint,
    );

    final labelStyle = TextStyle(color: labelColor, fontSize: 10);
    _drawLabel(canvas, '1', Offset(chart.left, chart.bottom + 8), labelStyle);
    _drawLabel(
      canvas,
      endLabel,
      Offset(chart.right - 12, chart.bottom + 8),
      labelStyle,
    );
    _drawLabel(canvas, '0', Offset(10, chart.bottom - 7), labelStyle);
    _drawLabel(
      canvas,
      NumberFormat.compact().format(scaleMax),
      const Offset(8, topPadding - 2),
      labelStyle,
    );

    for (final item in series) {
      final linePaint = Paint()
        ..color = item.category.color
        ..strokeWidth = 2.5
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
      final pointPaint = Paint()
        ..color = item.category.color
        ..style = PaintingStyle.fill;
      final path = Path();

      for (var index = 0; index < item.values.length; index += 1) {
        final x = item.values.length == 1
            ? chart.left
            : chart.left + chart.width * (index / (item.values.length - 1));
        final y = chart.bottom - (item.values[index] / scaleMax) * chart.height;
        if (index == 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
        if (item.values[index] > 0) {
          canvas.drawCircle(Offset(x, y), 3, pointPaint);
        }
      }
      canvas.drawPath(path, linePaint);
    }
  }

  void _drawLabel(Canvas canvas, String text, Offset offset, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: ui.TextDirection.ltr,
    )..layout();
    painter.paint(canvas, offset);
  }

  @override
  bool shouldRepaint(covariant _LineChartPainter oldDelegate) {
    return oldDelegate.series != series ||
        oldDelegate.endLabel != endLabel ||
        oldDelegate.axisColor != axisColor ||
        oldDelegate.labelColor != labelColor;
  }
}

class CategoriesPage extends StatefulWidget {
  const CategoriesPage({super.key, required this.store});

  final ExpenseStore store;

  @override
  State<CategoriesPage> createState() => _CategoriesPageState();
}

class _CategoriesPageState extends State<CategoriesPage> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: widget.store,
      builder: (context, _) {
        final categories = widget.store.selectableCategories;
        return Scaffold(
          appBar: AppBar(title: const Text('Categories')),
          body: SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              children: [
                TextField(
                  controller: _controller,
                  textInputAction: TextInputAction.done,
                  decoration: InputDecoration(
                    labelText: 'New category',
                    border: const OutlineInputBorder(),
                    suffixIcon: IconButton(
                      tooltip: 'Add category',
                      onPressed: _addCategory,
                      icon: const Icon(Icons.add),
                    ),
                  ),
                  onSubmitted: (_) => _addCategory(),
                ),
                const SizedBox(height: 16),
                ...categories.map(
                  (category) => _CategorySettingsTile(
                    category: category,
                    onRename: category.id == _otherCategoryId
                        ? null
                        : () => _renameCategory(category),
                    onDelete: category.id == _otherCategoryId
                        ? null
                        : () => widget.store.removeCategory(category.id),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  Future<void> _addCategory() async {
    await widget.store.addCategory(_controller.text);
    _controller.clear();
  }

  Future<void> _renameCategory(ExpenseCategoryDefinition category) async {
    final controller = TextEditingController(text: category.label);
    final renamed = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Rename category'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            labelText: 'Category name',
            border: OutlineInputBorder(),
          ),
          onSubmitted: (value) => Navigator.of(context).pop(value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (renamed != null) {
      await widget.store.updateCategory(category.id, renamed);
    }
  }
}

class _CategorySettingsTile extends StatelessWidget {
  const _CategorySettingsTile({
    required this.category,
    required this.onRename,
    required this.onDelete,
  });

  final ExpenseCategoryDefinition category;
  final VoidCallback? onRename;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(category.icon, color: category.color),
      title: Text(category.label),
      subtitle: category.id == _otherCategoryId
          ? const Text('Used when Gemini cannot match another category')
          : null,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            tooltip: 'Rename category',
            onPressed: onRename,
            icon: const Icon(Icons.edit_outlined),
          ),
          IconButton(
            tooltip: 'Delete category',
            onPressed: onDelete,
            icon: const Icon(Icons.delete_outline),
          ),
        ],
      ),
    );
  }
}

class ReceiptImportSheet extends StatefulWidget {
  const ReceiptImportSheet({
    super.key,
    required this.store,
    required this.receiptAiService,
  });

  final ExpenseStore store;
  final ReceiptAiService receiptAiService;

  @override
  State<ReceiptImportSheet> createState() => _ReceiptImportSheetState();
}

class _ReceiptImportSheetState extends State<ReceiptImportSheet> {
  final ImagePicker _imagePicker = ImagePicker();
  bool _isImporting = false;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Add from receipt',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            Text(
              'Choose a receipt image or file. Gemini will read it for review.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
            const SizedBox(height: 16),
            _ReceiptImportButton(
              icon: Icons.photo_camera_outlined,
              label: 'Take picture',
              onPressed: _isImporting
                  ? null
                  : () => _pickImage(ImageSource.camera),
            ),
            const SizedBox(height: 8),
            _ReceiptImportButton(
              icon: Icons.photo_library_outlined,
              label: 'Upload image',
              onPressed: _isImporting
                  ? null
                  : () => _pickImage(ImageSource.gallery),
            ),
            const SizedBox(height: 8),
            _ReceiptImportButton(
              icon: Icons.attach_file,
              label: 'Upload file',
              onPressed: _isImporting ? null : _pickFile,
            ),
            if (_isImporting) ...[
              const SizedBox(height: 16),
              const LinearProgressIndicator(),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _pickImage(ImageSource source) async {
    final image = await _imagePicker.pickImage(
      source: source,
      imageQuality: 85,
    );
    if (image == null) {
      return;
    }

    final bytes = await image.readAsBytes();
    await _importReceipt(
      bytes: bytes,
      mimeType: image.mimeType ?? _mimeTypeForName(image.name),
      fileName: image.name,
    );
  }

  Future<void> _pickFile() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['jpg', 'jpeg', 'png', 'webp', 'pdf'],
      withData: true,
    );
    if (result == null || result.files.isEmpty) {
      return;
    }

    final file = result.files.single;
    final bytes = file.bytes;
    if (bytes == null) {
      _showMessage('Could not read the selected file.');
      return;
    }

    await _importReceipt(
      bytes: bytes,
      mimeType: _mimeTypeForName(file.name),
      fileName: file.name,
    );
  }

  Future<void> _importReceipt({
    required Uint8List bytes,
    required String mimeType,
    required String fileName,
  }) async {
    setState(() => _isImporting = true);
    try {
      final expense = await widget.receiptAiService.extractExpense(
        bytes: bytes,
        mimeType: mimeType,
        fileName: fileName,
        categories: widget.store.selectableCategories,
      );

      if (!mounted) {
        return;
      }
      final navigator = Navigator.of(context);
      final messenger = ScaffoldMessenger.of(context);
      navigator.pop();
      final saved = await navigator.push<bool>(
        MaterialPageRoute(
          builder: (context) =>
              ReceiptReviewPage(store: widget.store, expense: expense),
        ),
      );
      if (saved == true) {
        messenger.showSnackBar(
          SnackBar(content: Text('Saved ${expense.title}')),
        );
      }
    } on ReceiptAiException catch (error) {
      _showMessage(error.message);
    } catch (error, stackTrace) {
      debugPrint('Receipt import parse error: $error');
      debugPrintStack(stackTrace: stackTrace);
      _showMessage('Could not import this receipt: $error');
    } finally {
      if (mounted) {
        setState(() => _isImporting = false);
      }
    }
  }

  void _showMessage(String message) {
    if (!mounted) {
      return;
    }
    showDialog<void>(
      context: context,
      builder: (context) {
        return AlertDialog(
          title: const Text('Upload issue'),
          content: Text(message),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Close'),
            ),
          ],
        );
      },
    );
  }

  String _mimeTypeForName(String name) {
    final lower = name.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
      return 'image/jpeg';
    }
    if (lower.endsWith('.png')) {
      return 'image/png';
    }
    if (lower.endsWith('.webp')) {
      return 'image/webp';
    }
    if (lower.endsWith('.pdf')) {
      return 'application/pdf';
    }
    return 'image/jpeg';
  }
}

class _ReceiptImportButton extends StatelessWidget {
  const _ReceiptImportButton({
    required this.icon,
    required this.label,
    required this.onPressed,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton.icon(
        onPressed: onPressed,
        icon: Icon(icon),
        label: Text(label),
      ),
    );
  }
}

class ReceiptReviewPage extends StatefulWidget {
  const ReceiptReviewPage({
    super.key,
    required this.store,
    required this.expense,
    this.isEditing = false,
  });

  final ExpenseStore store;
  final Expense expense;
  final bool isEditing;

  @override
  State<ReceiptReviewPage> createState() => _ReceiptReviewPageState();
}

class _ReceiptReviewPageState extends State<ReceiptReviewPage> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _titleController;
  late final TextEditingController _amountController;
  late final TextEditingController _noteController;
  late final TextEditingController _merchantController;
  late final TextEditingController _locationController;
  late final TextEditingController _currencyController;
  late final TextEditingController _paymentMethodController;
  late final TextEditingController _subtotalController;
  late final TextEditingController _taxController;
  late final TextEditingController _tipController;
  late DateTime _date;
  late String _categoryId;
  late List<_EditableReceiptItem> _items;
  late bool _isEditingFields;

  @override
  void initState() {
    super.initState();
    final details = widget.expense.receiptDetails;
    _titleController = TextEditingController(text: widget.expense.title);
    _amountController = TextEditingController(
      text: _formatEditableAmount(widget.expense.amount),
    );
    _noteController = TextEditingController(text: widget.expense.note);
    _merchantController = TextEditingController(text: details?.merchant ?? '');
    _locationController = TextEditingController(text: details?.location ?? '');
    _currencyController = TextEditingController(text: details?.currency ?? '');
    _paymentMethodController = TextEditingController(
      text: details?.paymentMethod ?? '',
    );
    _subtotalController = TextEditingController(
      text: _formatEditableNullableAmount(details?.subtotal),
    );
    _taxController = TextEditingController(
      text: _formatEditableNullableAmount(details?.tax),
    );
    _tipController = TextEditingController(
      text: _formatEditableNullableAmount(details?.tip),
    );
    _date = widget.expense.date;
    _categoryId =
        widget.store.selectableCategories.any(
          (category) => category.id == widget.expense.categoryId,
        )
        ? widget.expense.categoryId
        : _otherCategoryId;
    _isEditingFields = widget.isEditing;
    _items = (details?.items ?? const [])
        .map(_EditableReceiptItem.fromLineItem)
        .toList();
  }

  @override
  void dispose() {
    _titleController.dispose();
    _amountController.dispose();
    _noteController.dispose();
    _merchantController.dispose();
    _locationController.dispose();
    _currencyController.dispose();
    _paymentMethodController.dispose();
    _subtotalController.dispose();
    _taxController.dispose();
    _tipController.dispose();
    for (final item in _items) {
      item.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.isEditing ? 'Edit receipt' : 'Review receipt'),
        actions: [
          if (!_isEditingFields)
            TextButton.icon(
              onPressed: () => setState(() => _isEditingFields = true),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Edit'),
            ),
        ],
      ),
      body: SafeArea(
        child: _isEditingFields
            ? _buildEditForm(context)
            : _buildReceiptPreview(context),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
          child: FilledButton.icon(
            onPressed: _saveConfirmedExpense,
            icon: const Icon(Icons.check),
            label: Text(widget.isEditing ? 'Save changes' : 'Confirm and save'),
          ),
        ),
      ),
    );
  }

  Widget _buildReceiptPreview(BuildContext context) {
    final currency = NumberFormat.simpleCurrency(name: _currencyName);
    final amount = _parsePositiveAmount(_amountController.text);
    final subtotal = _parseOptionalAmount(_subtotalController.text);
    final tax = _parseOptionalAmount(_taxController.text);
    final tip = _parseOptionalAmount(_tipController.text);
    final items = _items
        .map((item) => item.toLineItem())
        .where((item) => item.name.isNotEmpty)
        .toList();

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
      children: [
        _ReceiptPaper(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                _displayValue(_merchantController.text, _titleController.text),
                textAlign: TextAlign.center,
                style: Theme.of(
                  context,
                ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w700),
              ),
              if (_locationController.text.trim().isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  _locationController.text.trim(),
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              const SizedBox(height: 6),
              Text(
                DateFormat.yMMMd().format(_date),
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 14),
              const Divider(height: 1),
              const SizedBox(height: 10),
              if (items.isEmpty)
                Text(
                  'No items found',
                  style: Theme.of(context).textTheme.bodyMedium,
                )
              else
                ...items.map(
                  (item) =>
                      _ReceiptPreviewItemRow(item: item, currency: currency),
                ),
              const SizedBox(height: 10),
              const Divider(height: 1),
              const SizedBox(height: 8),
              if (subtotal != null)
                _ReceiptPreviewAmountRow(
                  label: 'Subtotal',
                  value: currency.format(subtotal),
                ),
              if (tax != null)
                _ReceiptPreviewAmountRow(
                  label: 'Tax',
                  value: currency.format(tax),
                ),
              if (tip != null)
                _ReceiptPreviewAmountRow(
                  label: 'Tip',
                  value: currency.format(tip),
                ),
              _ReceiptPreviewAmountRow(
                label: 'Total',
                value: amount == null ? '-' : currency.format(amount),
                isTotal: true,
              ),
              const SizedBox(height: 10),
              const Divider(height: 1),
              const SizedBox(height: 10),
              _ReceiptPreviewMetaRow(
                label: 'Category',
                value: widget.store.categoryForId(_categoryId).label,
              ),
              if (_paymentMethodController.text.trim().isNotEmpty)
                _ReceiptPreviewMetaRow(
                  label: 'Payment',
                  value: _paymentMethodController.text.trim(),
                ),
              if (_noteController.text.trim().isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(
                  _noteController.text.trim(),
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: () => setState(() => _isEditingFields = true),
          icon: const Icon(Icons.edit_outlined),
          label: const Text('Edit extracted details'),
        ),
      ],
    );
  }

  Widget _buildEditForm(BuildContext context) {
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
        children: [
          _ReviewSection(
            title: 'Receipt summary',
            child: Column(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _merchantController,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Merchant',
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _amountController,
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        decoration: const InputDecoration(
                          labelText: 'Total amount',
                          border: OutlineInputBorder(),
                        ),
                        validator: (value) {
                          final amount = _parsePositiveAmount(value);
                          if (amount == null) {
                            return 'Enter an amount greater than 0';
                          }
                          return null;
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _titleController,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Title',
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter a title';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: DropdownButtonFormField<String>(
                        initialValue: _categoryId,
                        decoration: const InputDecoration(
                          labelText: 'Category',
                          border: OutlineInputBorder(),
                        ),
                        items: widget.store.selectableCategories
                            .map(
                              (category) => DropdownMenuItem(
                                value: category.id,
                                child: Row(
                                  children: [
                                    Icon(
                                      category.icon,
                                      color: category.color,
                                      size: 18,
                                    ),
                                    const SizedBox(width: 8),
                                    Text(category.label),
                                  ],
                                ),
                              ),
                            )
                            .toList(),
                        onChanged: (value) {
                          if (value != null) {
                            setState(() => _categoryId = value);
                          }
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    OutlinedButton.icon(
                      onPressed: _pickDate,
                      icon: const Icon(Icons.calendar_today_outlined),
                      label: Text(DateFormat.yMMMd().format(_date)),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _ReviewSection(
            title: 'Items',
            trailing: IconButton.outlined(
              tooltip: 'Add item',
              onPressed: _addItem,
              icon: const Icon(Icons.add),
            ),
            child: _items.isEmpty
                ? Text(
                    'No items found. Add items if you want to keep an itemized receipt.',
                    style: Theme.of(context).textTheme.bodyMedium,
                  )
                : Column(
                    children: _items.indexed
                        .map(
                          (entry) => _EditableReceiptItemCard(
                            key: ValueKey(entry.$2.id),
                            item: entry.$2,
                            onRemove: () => _removeItem(entry.$1),
                          ),
                        )
                        .toList(),
                  ),
          ),
          const SizedBox(height: 16),
          _ReviewDetailsPanel(
            locationController: _locationController,
            currencyController: _currencyController,
            paymentMethodController: _paymentMethodController,
            subtotalController: _subtotalController,
            taxController: _taxController,
            tipController: _tipController,
            noteController: _noteController,
            initiallyExpanded: widget.isEditing,
          ),
        ],
      ),
    );
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: _earliestExpenseDate,
      lastDate: DateTime.now(),
    );
    if (picked != null) {
      setState(() => _date = picked);
    }
  }

  void _addItem() {
    setState(() {
      _items.add(_EditableReceiptItem.empty());
    });
  }

  void _removeItem(int index) {
    setState(() {
      _items.removeAt(index).dispose();
    });
  }

  Future<void> _saveConfirmedExpense() async {
    if (_isEditingFields && !(_formKey.currentState?.validate() ?? false)) {
      return;
    }

    final amount = _parsePositiveAmount(_amountController.text);
    if (amount == null) {
      if (mounted) {
        setState(() => _isEditingFields = true);
      }
      return;
    }

    final details = ReceiptDetails(
      merchant: _merchantController.text.trim(),
      location: _locationController.text.trim(),
      currency: _currencyController.text.trim(),
      paymentMethod: _paymentMethodController.text.trim(),
      subtotal: _parseOptionalAmount(_subtotalController.text),
      tax: _parseOptionalAmount(_taxController.text),
      tip: _parseOptionalAmount(_tipController.text),
      items: ReceiptDetails.mergeLineItems(
        _items
            .map((item) => item.toLineItem())
            .where((item) => item.name.isNotEmpty)
            .toList(),
      ),
    );

    final updatedExpense = Expense(
      id: widget.expense.id,
      title: _titleController.text.trim(),
      amount: amount,
      date: _date,
      categoryId: _categoryId,
      note: _noteController.text.trim(),
      receiptDetails: details.hasContent ? details : null,
    );

    if (widget.isEditing) {
      await widget.store.updateExpense(updatedExpense);
    } else {
      await widget.store.addExpense(updatedExpense);
    }

    if (mounted) {
      Navigator.of(context).pop(true);
    }
  }

  double? _parsePositiveAmount(String? value) {
    final amount = _parseOptionalAmount(value);
    if (amount == null || amount <= 0) {
      return null;
    }
    return amount;
  }

  double? _parseOptionalAmount(String? value) {
    final trimmed = value?.trim();
    if (trimmed == null || trimmed.isEmpty) {
      return null;
    }
    return double.tryParse(trimmed.replaceAll(',', '.'));
  }

  String _formatEditableAmount(double value) {
    return value.toStringAsFixed(2);
  }

  String _formatEditableNullableAmount(double? value) {
    return value == null ? '' : _formatEditableAmount(value);
  }

  String? get _currencyName {
    final value = _currencyController.text.trim();
    if (value.isEmpty || value.length == 1) {
      return _defaultCurrencyCode;
    }
    return value.toUpperCase();
  }

  String _displayValue(String preferred, String fallback) {
    final preferredTrimmed = preferred.trim();
    if (preferredTrimmed.isNotEmpty) {
      return preferredTrimmed;
    }
    final fallbackTrimmed = fallback.trim();
    return fallbackTrimmed.isEmpty ? 'Receipt' : fallbackTrimmed;
  }
}

class _ReceiptPaper extends StatelessWidget {
  const _ReceiptPaper({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14, 16, 14, 14),
        child: child,
      ),
    );
  }
}

class _ReceiptPreviewItemRow extends StatelessWidget {
  const _ReceiptPreviewItemRow({required this.item, required this.currency});

  final ReceiptLineItem item;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    final quantity = item.quantity == null
        ? null
        : _formatQuantity(item.quantity!);
    final price = item.totalPrice ?? item.unitPrice;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              quantity == null ? item.name : '$quantity  ${item.name}',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ),
          const SizedBox(width: 12),
          Text(
            price == null ? '-' : currency.format(price),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }

  String _formatQuantity(double quantity) {
    if (quantity == quantity.roundToDouble()) {
      return quantity.toInt().toString();
    }
    return quantity.toStringAsFixed(2);
  }
}

class _ReceiptPreviewAmountRow extends StatelessWidget {
  const _ReceiptPreviewAmountRow({
    required this.label,
    required this.value,
    this.isTotal = false,
  });

  final String label;
  final String value;
  final bool isTotal;

  @override
  Widget build(BuildContext context) {
    final style = isTotal
        ? Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700)
        : Theme.of(context).textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(child: Text(label, style: style)),
          Text(value, style: style),
        ],
      ),
    );
  }
}

class _ReceiptPreviewMetaRow extends StatelessWidget {
  const _ReceiptPreviewMetaRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          SizedBox(
            width: 76,
            child: Text(label, style: Theme.of(context).textTheme.bodySmall),
          ),
          Expanded(
            child: Text(value, style: Theme.of(context).textTheme.bodySmall),
          ),
        ],
      ),
    );
  }
}

class _ReviewSection extends StatelessWidget {
  const _ReviewSection({
    required this.title,
    required this.child,
    this.trailing,
  });

  final String title;
  final Widget child;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            ?trailing,
          ],
        ),
        const SizedBox(height: 10),
        child,
      ],
    );
  }
}

class _ReviewDetailsPanel extends StatelessWidget {
  const _ReviewDetailsPanel({
    required this.locationController,
    required this.currencyController,
    required this.paymentMethodController,
    required this.subtotalController,
    required this.taxController,
    required this.tipController,
    required this.noteController,
    required this.initiallyExpanded,
  });

  final TextEditingController locationController;
  final TextEditingController currencyController;
  final TextEditingController paymentMethodController;
  final TextEditingController subtotalController;
  final TextEditingController taxController;
  final TextEditingController tipController;
  final TextEditingController noteController;
  final bool initiallyExpanded;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ExpansionTile(
        initiallyExpanded: initiallyExpanded,
        tilePadding: const EdgeInsets.symmetric(horizontal: 12),
        childrenPadding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
        title: const Text('More details'),
        children: [
          TextFormField(
            controller: locationController,
            decoration: const InputDecoration(
              labelText: 'Location',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  controller: currencyController,
                  decoration: const InputDecoration(
                    labelText: 'Currency',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: TextFormField(
                  controller: paymentMethodController,
                  decoration: const InputDecoration(
                    labelText: 'Payment',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: _OptionalAmountField(
                  controller: subtotalController,
                  label: 'Subtotal',
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _OptionalAmountField(
                  controller: taxController,
                  label: 'Tax',
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: _OptionalAmountField(
                  controller: tipController,
                  label: 'Tip',
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: noteController,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: 'Note',
              border: OutlineInputBorder(),
            ),
          ),
        ],
      ),
    );
  }
}

class _OptionalAmountField extends StatelessWidget {
  const _OptionalAmountField({required this.controller, required this.label});

  final TextEditingController controller;
  final String label;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
      ),
      validator: (value) {
        final trimmed = value?.trim();
        if (trimmed == null || trimmed.isEmpty) {
          return null;
        }
        if (double.tryParse(trimmed.replaceAll(',', '.')) == null) {
          return 'Invalid';
        }
        return null;
      },
    );
  }
}

class _EditableReceiptItemCard extends StatelessWidget {
  const _EditableReceiptItemCard({
    super.key,
    required this.item,
    required this.onRemove,
  });

  final _EditableReceiptItem item;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border.all(
            color: Theme.of(context).colorScheme.outlineVariant,
          ),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: TextFormField(
                      controller: item.nameController,
                      decoration: const InputDecoration(
                        labelText: 'Item name',
                        border: OutlineInputBorder(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton(
                    tooltip: 'Remove item',
                    onPressed: onRemove,
                    icon: const Icon(Icons.delete_outline),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                    child: _OptionalAmountField(
                      controller: item.quantityController,
                      label: 'Qty',
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _OptionalAmountField(
                      controller: item.unitPriceController,
                      label: 'Unit price',
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: _OptionalAmountField(
                      controller: item.totalPriceController,
                      label: 'Price',
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _EditableReceiptItem {
  _EditableReceiptItem({
    required this.nameController,
    required this.quantityController,
    required this.unitPriceController,
    required this.totalPriceController,
  }) : id = DateTime.now().microsecondsSinceEpoch.toString();

  factory _EditableReceiptItem.empty() {
    return _EditableReceiptItem(
      nameController: TextEditingController(),
      quantityController: TextEditingController(),
      unitPriceController: TextEditingController(),
      totalPriceController: TextEditingController(),
    );
  }

  factory _EditableReceiptItem.fromLineItem(ReceiptLineItem item) {
    return _EditableReceiptItem(
      nameController: TextEditingController(text: item.name),
      quantityController: TextEditingController(
        text: _formatNullable(item.quantity),
      ),
      unitPriceController: TextEditingController(
        text: _formatNullable(item.unitPrice),
      ),
      totalPriceController: TextEditingController(
        text: _formatNullable(item.totalPrice),
      ),
    );
  }

  final String id;
  final TextEditingController nameController;
  final TextEditingController quantityController;
  final TextEditingController unitPriceController;
  final TextEditingController totalPriceController;

  ReceiptLineItem toLineItem() {
    return ReceiptLineItem(
      name: nameController.text.trim(),
      quantity: _parseOptional(quantityController.text),
      unitPrice: _parseOptional(unitPriceController.text),
      totalPrice: _parseOptional(totalPriceController.text),
    );
  }

  void dispose() {
    nameController.dispose();
    quantityController.dispose();
    unitPriceController.dispose();
    totalPriceController.dispose();
  }

  static String _formatNullable(double? value) {
    return value == null ? '' : value.toStringAsFixed(2);
  }

  static double? _parseOptional(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return null;
    }
    return double.tryParse(trimmed.replaceAll(',', '.'));
  }
}

class _ExpenseDashboard extends StatelessWidget {
  const _ExpenseDashboard({required this.store});

  final ExpenseStore store;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _SummaryPanel(store: store),
                const SizedBox(height: 20),
                _FixedCostsSection(store: store),
                const SizedBox(height: 20),
                Text(
                  'Recent expenses',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
              ],
            ),
          ),
        ),
        if (store.expenses.isEmpty)
          const SliverFillRemaining(hasScrollBody: false, child: _EmptyState())
        else
          SliverList.separated(
            itemCount: store.expenses.length,
            separatorBuilder: (context, index) => const Divider(height: 1),
            itemBuilder: (context, index) {
              final expense = store.expenses[index];
              return Dismissible(
                key: ValueKey(expense.id),
                direction: DismissDirection.endToStart,
                background: Container(
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.only(right: 20),
                  color: Theme.of(context).colorScheme.errorContainer,
                  child: Icon(
                    Icons.delete_outline,
                    color: Theme.of(context).colorScheme.onErrorContainer,
                  ),
                ),
                onDismissed: (_) => store.removeExpense(expense.id),
                child: _ExpenseTile(
                  expense: expense,
                  category: store.categoryForId(expense.categoryId),
                  onTap: () => _showExpenseDetails(context, store, expense),
                ),
              );
            },
          ),
      ],
    );
  }

  void _showExpenseDetails(
    BuildContext context,
    ExpenseStore store,
    Expense expense,
  ) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => ExpenseDetailsSheet(store: store, expense: expense),
    );
  }
}

class _SummaryPanel extends StatelessWidget {
  const _SummaryPanel({required this.store});

  final ExpenseStore store;

  @override
  Widget build(BuildContext context) {
    final currency = _defaultCurrencyFormat();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: _SummaryMetric(
              label: 'This month',
              value: currency.format(store.currentMonthSpent),
            ),
          ),
          const SizedBox(width: 16),
          Expanded(
            child: _SummaryMetric(
              label: 'All time',
              value: currency.format(store.totalSpent),
            ),
          ),
        ],
      ),
    );
  }
}

class _SummaryMetric extends StatelessWidget {
  const _SummaryMetric({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: Theme.of(context).textTheme.labelLarge?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontWeight: FontWeight.w500,
          ),
        ),
        const SizedBox(height: 6),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w700,
              color: Theme.of(context).colorScheme.onSurface,
            ),
          ),
        ),
      ],
    );
  }
}

class _FixedCostsSection extends StatelessWidget {
  const _FixedCostsSection({required this.store});

  final ExpenseStore store;

  @override
  Widget build(BuildContext context) {
    final currency = _defaultCurrencyFormat();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'Fixed monthly costs',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            Text(
              currency.format(store.fixedMonthlyTotal),
              style: Theme.of(
                context,
              ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w700),
            ),
            const SizedBox(width: 8),
            IconButton.filledTonal(
              tooltip: 'Add fixed cost',
              onPressed: () => _showFixedCostSheet(context),
              icon: const Icon(Icons.add),
            ),
          ],
        ),
        const SizedBox(height: 8),
        if (store.fixedCosts.isEmpty)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.surface,
              border: Border.all(
                color: Theme.of(context).colorScheme.outlineVariant,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              'Add rent, subscriptions, insurance, or other recurring monthly costs.',
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          )
        else
          Column(
            children: store.fixedCosts.map((fixedCost) {
              return Dismissible(
                key: ValueKey('fixed-${fixedCost.id}'),
                direction: DismissDirection.endToStart,
                background: Container(
                  alignment: Alignment.centerRight,
                  padding: const EdgeInsets.only(right: 20),
                  color: Theme.of(context).colorScheme.errorContainer,
                  child: Icon(
                    Icons.delete_outline,
                    color: Theme.of(context).colorScheme.onErrorContainer,
                  ),
                ),
                onDismissed: (_) => store.removeFixedCost(fixedCost.id),
                child: _FixedCostTile(
                  fixedCost: fixedCost,
                  category: store.categoryForId(fixedCost.categoryId),
                  onTap: () => _showFixedCostSheet(context, fixedCost),
                ),
              );
            }).toList(),
          ),
      ],
    );
  }

  void _showFixedCostSheet(BuildContext context, [FixedCost? fixedCost]) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => FixedCostSheet(store: store, fixedCost: fixedCost),
    );
  }
}

class _FixedCostTile extends StatelessWidget {
  const _FixedCostTile({
    required this.fixedCost,
    required this.category,
    required this.onTap,
  });

  final FixedCost fixedCost;
  final ExpenseCategoryDefinition category;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final currency = _defaultCurrencyFormat();
    final dateLabel = fixedCost.dayOfMonth == null
        ? 'No fixed date'
        : 'Monthly on day ${fixedCost.dayOfMonth}';

    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        category.icon,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      title: Text(fixedCost.title),
      subtitle: Text('${category.label} - $dateLabel'),
      onTap: onTap,
      trailing: FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(
          currency.format(fixedCost.amount),
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
    );
  }
}

class _ExpenseTile extends StatelessWidget {
  const _ExpenseTile({
    required this.expense,
    required this.category,
    required this.onTap,
  });

  final Expense expense;
  final ExpenseCategoryDefinition category;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final currency = _defaultCurrencyFormat();
    final date = DateFormat.yMMMd().format(expense.date);

    return ListTile(
      leading: Icon(
        category.icon,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
      title: Text(expense.title),
      subtitle: Text('${category.label} - $date'),
      onTap: onTap,
      trailing: FittedBox(
        fit: BoxFit.scaleDown,
        child: Text(
          currency.format(expense.amount),
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
    );
  }
}

class ExpenseDetailsSheet extends StatelessWidget {
  const ExpenseDetailsSheet({
    super.key,
    required this.store,
    required this.expense,
  });

  final ExpenseStore store;
  final Expense expense;

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;
    final currency = NumberFormat.simpleCurrency(
      name: _currencyName(expense.receiptDetails?.currency),
    );
    final details = expense.receiptDetails;
    final category = store.categoryForId(expense.categoryId);

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, bottomInset + 16),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    category.icon,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          expense.title,
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '${category.label} - ${DateFormat.yMMMd().format(expense.date)}',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ],
                    ),
                  ),
                  Text(
                    currency.format(expense.amount),
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 20),
              if (details != null && details.hasContent) ...[
                _ReceiptMetaGrid(details: details, currency: currency),
                if (details.items.isNotEmpty) ...[
                  const SizedBox(height: 20),
                  Text('Items', style: Theme.of(context).textTheme.titleMedium),
                  const SizedBox(height: 8),
                  _ReceiptItemsList(items: details.items, currency: currency),
                ],
                const SizedBox(height: 20),
                _ReceiptTotals(
                  expense: expense,
                  details: details,
                  currency: currency,
                ),
              ] else
                Text(
                  'No receipt details saved for this expense.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              if (expense.note.isNotEmpty) ...[
                const SizedBox(height: 20),
                Text('Note', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 8),
                Text(expense.note),
              ],
              const SizedBox(height: 20),
              SizedBox(
                width: double.infinity,
                child: OutlinedButton.icon(
                  onPressed: () => _editExpense(context),
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Edit'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String? _currencyName(String? currency) {
    final value = currency?.trim();
    if (value == null || value.isEmpty || value.length == 1) {
      return _defaultCurrencyCode;
    }
    return value.toUpperCase();
  }

  Future<void> _editExpense(BuildContext context) async {
    final navigator = Navigator.of(context);
    navigator.pop();
    await navigator.push<bool>(
      MaterialPageRoute(
        builder: (context) =>
            ReceiptReviewPage(store: store, expense: expense, isEditing: true),
      ),
    );
  }
}

class _ReceiptMetaGrid extends StatelessWidget {
  const _ReceiptMetaGrid({required this.details, required this.currency});

  final ReceiptDetails details;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    final rows = <_ReceiptMetaRow>[
      if (details.merchant.isNotEmpty)
        _ReceiptMetaRow(
          Icons.storefront_outlined,
          'Merchant',
          details.merchant,
        ),
      if (details.location.isNotEmpty)
        _ReceiptMetaRow(
          Icons.location_on_outlined,
          'Location',
          details.location,
        ),
      if (details.paymentMethod.isNotEmpty)
        _ReceiptMetaRow(
          Icons.credit_card_outlined,
          'Payment',
          details.paymentMethod,
        ),
      if (details.currency.isNotEmpty)
        _ReceiptMetaRow(Icons.payments_outlined, 'Currency', details.currency),
    ];

    if (rows.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      children: rows
          .map(
            (row) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    row.icon,
                    size: 20,
                    color: Theme.of(context).colorScheme.primary,
                  ),
                  const SizedBox(width: 10),
                  SizedBox(
                    width: 86,
                    child: Text(
                      row.label,
                      style: Theme.of(context).textTheme.labelLarge,
                    ),
                  ),
                  Expanded(child: Text(row.value)),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}

class _ReceiptMetaRow {
  const _ReceiptMetaRow(this.icon, this.label, this.value);

  final IconData icon;
  final String label;
  final String value;
}

class _ReceiptItemsList extends StatelessWidget {
  const _ReceiptItemsList({required this.items, required this.currency});

  final List<ReceiptLineItem> items;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: items.map((item) {
        final quantity = item.quantity == null
            ? ''
            : 'x${_formatQuantity(item.quantity!)}';
        final price = item.totalPrice ?? item.unitPrice;
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.remove,
                size: 16,
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(item.name),
                    if (quantity.isNotEmpty)
                      Text(
                        quantity,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                  ],
                ),
              ),
              if (price != null)
                Text(
                  currency.format(price),
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
            ],
          ),
        );
      }).toList(),
    );
  }

  String _formatQuantity(double quantity) {
    if (quantity == quantity.roundToDouble()) {
      return quantity.toInt().toString();
    }
    return quantity.toStringAsFixed(2);
  }
}

class _ReceiptTotals extends StatelessWidget {
  const _ReceiptTotals({
    required this.expense,
    required this.details,
    required this.currency,
  });

  final Expense expense;
  final ReceiptDetails details;
  final NumberFormat currency;

  @override
  Widget build(BuildContext context) {
    final rows = <MapEntry<String, double?>>[
      MapEntry('Subtotal', details.subtotal),
      MapEntry('Tax', details.tax),
      MapEntry('Tip', details.tip),
      MapEntry('Total', expense.amount),
    ].where((entry) => entry.value != null).toList();

    return Column(
      children: rows.map((row) {
        final isTotal = row.key == 'Total';
        return Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  row.key,
                  style: isTotal
                      ? Theme.of(context).textTheme.titleMedium
                      : Theme.of(context).textTheme.bodyMedium,
                ),
              ),
              Text(
                currency.format(row.value!),
                style: isTotal
                    ? Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      )
                    : Theme.of(context).textTheme.bodyMedium,
              ),
            ],
          ),
        );
      }).toList(),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.receipt_long_outlined,
              size: 56,
              color: Theme.of(context).colorScheme.outline,
            ),
            const SizedBox(height: 12),
            Text(
              'No expenses yet',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 6),
            Text(
              'Add your first expense to start tracking where your money goes.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}

class FixedCostSheet extends StatefulWidget {
  const FixedCostSheet({super.key, required this.store, this.fixedCost});

  final ExpenseStore store;
  final FixedCost? fixedCost;

  @override
  State<FixedCostSheet> createState() => _FixedCostSheetState();
}

class _FixedCostSheetState extends State<FixedCostSheet> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _amountController = TextEditingController();
  final _noteController = TextEditingController();
  String _categoryId = ExpenseCategory.groceries.name;
  int? _dayOfMonth;

  bool get _isEditing => widget.fixedCost != null;

  @override
  void initState() {
    super.initState();
    final fixedCost = widget.fixedCost;
    _categoryId =
        fixedCost?.categoryId ?? widget.store.selectableCategories.first.id;
    _dayOfMonth = fixedCost?.dayOfMonth;
    if (fixedCost != null) {
      _titleController.text = fixedCost.title;
      _amountController.text = _formatEditableAmount(fixedCost.amount);
      _noteController.text = fixedCost.note;
    }
  }

  @override
  void dispose() {
    _titleController.dispose();
    _amountController.dispose();
    _noteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, bottomInset + 16),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _isEditing ? 'Edit fixed cost' : 'Add fixed cost',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _titleController,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Title',
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter a title';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _amountController,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'Monthly amount',
                    prefixText: '€ ',
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    final amount = double.tryParse(
                      (value ?? '').replaceAll(',', '.'),
                    );
                    if (amount == null || amount <= 0) {
                      return 'Enter an amount greater than 0';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _categoryId,
                  decoration: const InputDecoration(
                    labelText: 'Category',
                    border: OutlineInputBorder(),
                  ),
                  items: widget.store.selectableCategories
                      .map(
                        (category) => DropdownMenuItem(
                          value: category.id,
                          child: Row(
                            children: [
                              Icon(
                                category.icon,
                                color: category.color,
                                size: 18,
                              ),
                              const SizedBox(width: 8),
                              Text(category.label),
                            ],
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) {
                    if (value != null) {
                      setState(() => _categoryId = value);
                    }
                  },
                ),
                const SizedBox(height: 12),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('Monthly date'),
                  subtitle: Text(
                    _dayOfMonth == null
                        ? 'No fixed date'
                        : 'Day $_dayOfMonth each month',
                  ),
                  value: _dayOfMonth != null,
                  onChanged: (value) {
                    setState(() => _dayOfMonth = value ? 1 : null);
                  },
                ),
                if (_dayOfMonth != null) ...[
                  const SizedBox(height: 4),
                  DropdownButtonFormField<int>(
                    initialValue: _dayOfMonth,
                    decoration: const InputDecoration(
                      labelText: 'Day of month',
                      border: OutlineInputBorder(),
                    ),
                    items: List.generate(31, (index) => index + 1)
                        .map(
                          (day) => DropdownMenuItem(
                            value: day,
                            child: Text(day.toString()),
                          ),
                        )
                        .toList(),
                    onChanged: (value) {
                      setState(() => _dayOfMonth = value);
                    },
                  ),
                ],
                const SizedBox(height: 12),
                TextFormField(
                  controller: _noteController,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'Note',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _saveFixedCost,
                    icon: const Icon(Icons.check),
                    label: Text(
                      _isEditing ? 'Save changes' : 'Save fixed cost',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _saveFixedCost() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final fixedCost = FixedCost(
      id:
          widget.fixedCost?.id ??
          DateTime.now().microsecondsSinceEpoch.toString(),
      title: _titleController.text.trim(),
      amount: double.parse(_amountController.text.replaceAll(',', '.')),
      categoryId: _categoryId,
      dayOfMonth: _dayOfMonth,
      note: _noteController.text.trim(),
    );

    if (_isEditing) {
      await widget.store.updateFixedCost(fixedCost);
    } else {
      await widget.store.addFixedCost(fixedCost);
    }

    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  String _formatEditableAmount(double value) {
    return value == value.roundToDouble()
        ? value.toInt().toString()
        : value.toStringAsFixed(2);
  }
}

class AddExpenseSheet extends StatefulWidget {
  const AddExpenseSheet({super.key, required this.store});

  final ExpenseStore store;

  @override
  State<AddExpenseSheet> createState() => _AddExpenseSheetState();
}

class _AddExpenseSheetState extends State<AddExpenseSheet> {
  final _formKey = GlobalKey<FormState>();
  final _titleController = TextEditingController();
  final _amountController = TextEditingController();
  final _noteController = TextEditingController();
  String _categoryId = ExpenseCategory.groceries.name;
  DateTime _date = DateTime.now();

  @override
  void initState() {
    super.initState();
    _categoryId = widget.store.selectableCategories.first.id;
  }

  @override
  void dispose() {
    _titleController.dispose();
    _amountController.dispose();
    _noteController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.viewInsetsOf(context).bottom;

    return SafeArea(
      child: Padding(
        padding: EdgeInsets.fromLTRB(16, 16, 16, bottomInset + 16),
        child: Form(
          key: _formKey,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Add expense',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _titleController,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Title',
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    if (value == null || value.trim().isEmpty) {
                      return 'Enter a title';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _amountController,
                  keyboardType: const TextInputType.numberWithOptions(
                    decimal: true,
                  ),
                  decoration: const InputDecoration(
                    labelText: 'Amount',
                    prefixText: '€ ',
                    border: OutlineInputBorder(),
                  ),
                  validator: (value) {
                    final amount = double.tryParse(value ?? '');
                    if (amount == null || amount <= 0) {
                      return 'Enter an amount greater than 0';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  initialValue: _categoryId,
                  decoration: const InputDecoration(
                    labelText: 'Category',
                    border: OutlineInputBorder(),
                  ),
                  items: widget.store.selectableCategories
                      .map(
                        (category) => DropdownMenuItem(
                          value: category.id,
                          child: Row(
                            children: [
                              Icon(
                                category.icon,
                                color: category.color,
                                size: 18,
                              ),
                              const SizedBox(width: 8),
                              Text(category.label),
                            ],
                          ),
                        ),
                      )
                      .toList(),
                  onChanged: (value) {
                    if (value != null) {
                      setState(() => _categoryId = value);
                    }
                  },
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  onPressed: _pickDate,
                  icon: const Icon(Icons.calendar_today_outlined),
                  label: Text(DateFormat.yMMMd().format(_date)),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _noteController,
                  minLines: 2,
                  maxLines: 4,
                  decoration: const InputDecoration(
                    labelText: 'Note',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _saveExpense,
                    icon: const Icon(Icons.check),
                    label: const Text('Save expense'),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: _earliestExpenseDate,
      lastDate: DateTime.now(),
    );

    if (picked != null) {
      setState(() => _date = picked);
    }
  }

  Future<void> _saveExpense() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }

    final amount = double.tryParse(_amountController.text) ?? 0;

    await widget.store.addExpense(
      Expense(
        id: DateTime.now().microsecondsSinceEpoch.toString(),
        title: _titleController.text.trim(),
        amount: amount,
        date: _date,
        categoryId: _categoryId,
        note: _noteController.text.trim(),
      ),
    );

    if (mounted) {
      Navigator.of(context).pop();
    }
  }
}
