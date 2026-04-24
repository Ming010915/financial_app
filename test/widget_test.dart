import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:personal_finance_tracker/main.dart';

void main() {
  ExpenseStore createStore() {
    return ExpenseStore(database: MemoryFinanceDatabase());
  }

  testWidgets('shows expenses home screen', (tester) async {
    final store = createStore();
    await store.load();

    await tester.pumpWidget(MaterialApp(home: ExpenseHomePage(store: store)));
    await tester.pump();

    expect(find.text('Expenses'), findsOneWidget);
    expect(find.byIcon(Icons.add), findsWidgets);
  });

  testWidgets('shows receipt details', (tester) async {
    final store = createStore();
    await store.load();

    final expense = Expense(
      id: '1',
      title: 'Corner Market',
      amount: 12.50,
      date: DateTime(2026, 4, 24),
      categoryId: ExpenseCategory.groceries.name,
      note: 'Imported from receipt',
      receiptDetails: const ReceiptDetails(
        merchant: 'Corner Market',
        location: 'Munich',
        currency: 'EUR',
        subtotal: 10.50,
        tax: 2.00,
        items: [
          ReceiptLineItem(name: 'Milk', quantity: 1, totalPrice: 2.50),
          ReceiptLineItem(name: 'Bread', quantity: 2, totalPrice: 4.00),
        ],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ExpenseDetailsSheet(store: store, expense: expense),
        ),
      ),
    );

    expect(find.text('Corner Market'), findsWidgets);
    expect(find.text('Munich'), findsOneWidget);
    expect(find.text('Milk'), findsOneWidget);
    expect(find.text('Bread'), findsOneWidget);
    expect(find.text('Imported from receipt'), findsOneWidget);
  });

  testWidgets('opens category summaries and switches chart type', (
    tester,
  ) async {
    final store = createStore();
    await store.load();
    final now = DateTime.now();
    await store.addExpense(
      Expense(
        id: 'summary-1',
        title: 'Groceries',
        amount: 45,
        date: now,
        categoryId: ExpenseCategory.groceries.name,
      ),
    );
    await store.addExpense(
      Expense(
        id: 'summary-2',
        title: 'Dinner',
        amount: 30,
        date: now,
        categoryId: ExpenseCategory.dining.name,
      ),
    );
    await store.addFixedCost(
      FixedCost(
        id: 'summary-fixed-1',
        title: 'Rent',
        amount: 900,
        categoryId: ExpenseCategory.housing.name,
      ),
    );

    await tester.pumpWidget(MaterialApp(home: ExpenseHomePage(store: store)));

    await tester.tap(find.byTooltip('Summaries'));
    await tester.pumpAndSettle();

    expect(find.text('Summaries'), findsOneWidget);
    expect(find.text('Weekly'), findsOneWidget);
    expect(find.text('Monthly'), findsOneWidget);
    expect(find.text('Yearly'), findsOneWidget);
    expect(find.text('Pie'), findsOneWidget);
    expect(find.text('Line'), findsOneWidget);
    expect(find.text('Category split'), findsOneWidget);
    expect(find.text('Groceries'), findsWidgets);
    expect(find.text('Dining'), findsWidgets);

    await tester.tap(find.text('Line'));
    await tester.pumpAndSettle();

    expect(find.text('Category trends'), findsOneWidget);
    expect(find.byType(CustomPaint), findsWidgets);

    await tester.tap(find.text('Monthly'));
    await tester.pumpAndSettle();

    expect(find.text('Category trends'), findsOneWidget);
    expect(find.text('Housing'), findsWidgets);
  });

  testWidgets('adds and edits a fixed monthly cost without requiring a date', (
    tester,
  ) async {
    final store = createStore();
    await store.load();

    await tester.pumpWidget(MaterialApp(home: ExpenseHomePage(store: store)));

    expect(find.text('Fixed monthly costs'), findsOneWidget);
    await tester.tap(find.byTooltip('Add fixed cost'));
    await tester.pumpAndSettle();

    await tester.enterText(find.widgetWithText(TextFormField, 'Title'), 'Rent');
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Monthly amount'),
      '950',
    );
    await tester.tap(find.text('Save fixed cost'));
    await tester.pumpAndSettle();

    expect(store.fixedCosts.length, 1);
    expect(store.fixedCosts.single.title, 'Rent');
    expect(store.fixedCosts.single.dayOfMonth, isNull);
    expect(find.textContaining('No fixed date'), findsOneWidget);

    await tester.tap(find.text('Rent'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Monthly amount'),
      '975',
    );
    await tester.tap(find.text('Monthly date'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save changes'));
    await tester.pumpAndSettle();

    expect(store.fixedCosts.length, 1);
    expect(store.fixedCosts.single.amount, 975);
    expect(store.fixedCosts.single.dayOfMonth, 1);
  });

  testWidgets('edits receipt review before saving', (tester) async {
    final store = createStore();
    await store.load();

    final expense = Expense(
      id: 'review-1',
      title: 'Old Store',
      amount: 5,
      date: DateTime(2026, 4, 24),
      categoryId: ExpenseCategory.groceries.name,
      receiptDetails: const ReceiptDetails(
        merchant: 'Old Store',
        items: [ReceiptLineItem(name: 'Old item', quantity: 1, totalPrice: 5)],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ReceiptReviewPage(store: store, expense: expense),
      ),
    );

    expect(find.text('Review receipt'), findsOneWidget);
    expect(find.text('Old Store'), findsWidgets);
    await tester.tap(find.text('Edit extracted details'));
    await tester.pumpAndSettle();

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Title'),
      'Bakery',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Total amount'),
      '8.50',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Merchant'),
      'Corner Bakery',
    );
    await tester.scrollUntilVisible(
      find.widgetWithText(TextFormField, 'Item name'),
      250,
      scrollable: find.byType(Scrollable).first,
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Item name'),
      'Croissant',
    );
    await tester.enterText(find.widgetWithText(TextFormField, 'Qty'), '2');
    await tester.enterText(find.widgetWithText(TextFormField, 'Price'), '8.50');
    await tester.tap(find.text('Confirm and save'));
    await tester.pumpAndSettle();

    expect(store.expenses.single.title, 'Bakery');
    expect(store.expenses.single.amount, 8.50);
    expect(store.expenses.single.receiptDetails?.merchant, 'Corner Bakery');
    expect(
      store.expenses.single.receiptDetails?.items.single.name,
      'Croissant',
    );
    expect(store.expenses.single.receiptDetails?.items.single.quantity, 2);
  });

  testWidgets('saves receipt directly from preview', (tester) async {
    final store = createStore();
    await store.load();

    final expense = Expense(
      id: 'preview-1',
      title: 'Coffee Shop',
      amount: 3.75,
      date: DateTime(2026, 4, 24),
      categoryId: ExpenseCategory.dining.name,
      receiptDetails: const ReceiptDetails(
        merchant: 'Coffee Shop',
        items: [
          ReceiptLineItem(name: 'Espresso', quantity: 1, totalPrice: 3.75),
        ],
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ReceiptReviewPage(store: store, expense: expense),
      ),
    );

    expect(find.text('Coffee Shop'), findsWidgets);
    expect(find.widgetWithText(TextFormField, 'Title'), findsNothing);

    await tester.tap(find.text('Confirm and save'));
    await tester.pumpAndSettle();

    expect(store.expenses.length, 1);
    expect(store.expenses.single.title, 'Coffee Shop');
    expect(store.expenses.single.amount, 3.75);
  });

  testWidgets('merges duplicate receipt items', (tester) async {
    final details = ReceiptDetails.fromJson({
      'items': [
        {'name': 'Milk', 'quantity': 1, 'unitPrice': 2.5, 'totalPrice': 2.5},
        {'name': ' milk ', 'quantity': 2, 'unitPrice': 2.5, 'totalPrice': 5.0},
        {'name': 'Bread', 'quantity': 1, 'totalPrice': 3.0},
      ],
    });

    expect(details.items.length, 2);
    expect(details.items.first.name, 'Milk');
    expect(details.items.first.quantity, 3);
    expect(details.items.first.unitPrice, 2.5);
    expect(details.items.first.totalPrice, 7.5);
  });

  testWidgets('parses flexible Gemini item values', (tester) async {
    final details = ReceiptDetails.fromJson({
      'payment_method': 'card',
      'subtotal': '€10,50',
      'tax': '1.20',
      'items': [
        {
          'name': 'Bagel',
          'quantity': '2',
          'unit_price': '3.00',
          'total_price': '6.00',
        },
      ],
    });

    expect(details.paymentMethod, 'card');
    expect(details.subtotal, 10.50);
    expect(details.tax, 1.20);
    expect(details.items.single.quantity, 2);
    expect(details.items.single.unitPrice, 3);
    expect(details.items.single.totalPrice, 6);
  });

  testWidgets('edits saved receipt without duplicating it', (tester) async {
    final store = createStore();
    await store.load();
    await store.addExpense(
      Expense(
        id: 'saved-1',
        title: 'Old receipt',
        amount: 4,
        date: DateTime(2026, 4, 24),
        categoryId: ExpenseCategory.dining.name,
        receiptDetails: const ReceiptDetails(
          merchant: 'Old merchant',
          items: [ReceiptLineItem(name: 'Tea', quantity: 1, totalPrice: 4)],
        ),
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        home: ReceiptReviewPage(
          store: store,
          expense: store.expenses.single,
          isEditing: true,
        ),
      ),
    );

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Title'),
      'Updated receipt',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Total amount'),
      '6.25',
    );
    await tester.tap(find.text('Save changes'));
    await tester.pumpAndSettle();

    expect(store.expenses.length, 1);
    expect(store.expenses.single.id, 'saved-1');
    expect(store.expenses.single.title, 'Updated receipt');
    expect(store.expenses.single.amount, 6.25);
  });
}

class MemoryFinanceDatabase extends FinanceDatabase {
  List<Expense> _expenses = [];
  List<FixedCost> _fixedCosts = [];
  List<ExpenseCategoryDefinition> _categories = [];

  @override
  Future<FinanceDataSnapshot> load() async {
    return FinanceDataSnapshot(
      expenses: List.of(_expenses),
      fixedCosts: List.of(_fixedCosts),
      categories: List.of(_categories),
    );
  }

  @override
  Future<void> saveExpenses(List<Expense> expenses) async {
    _expenses = List.of(expenses);
  }

  @override
  Future<void> saveFixedCosts(List<FixedCost> fixedCosts) async {
    _fixedCosts = List.of(fixedCosts);
  }

  @override
  Future<void> saveCategories(
    List<ExpenseCategoryDefinition> categories,
  ) async {
    _categories = List.of(categories);
  }
}
